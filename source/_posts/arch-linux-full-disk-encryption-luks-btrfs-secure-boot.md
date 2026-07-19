---
title: Archlinux安装——UEFI 全盘加密（btrfs LUKS） 安全启动（systemd-boot UKI） TPM2自动解锁 基于ThinkPad X1 Carbon Gen 9（2021）
date: 2026-04-06 17:03:38
categories: [Linux Security]
tags: [Arch Linux, LUKS, Btrfs, Secure Boot, systemd-boot, TPM2]
description: 在 ThinkPad X1 Carbon Gen 9 上安装 Arch Linux 的完整记录：LUKS2 全盘加密 + btrfs 子卷与 snapper 快照、systemd-boot UKI、sbctl 自管密钥的 Secure Boot 与 TPM2 自动解锁，讲清四者环环相扣的安全逻辑与各环节验证方法。
---

{% note info %}
作者声明：本文整理自在 ThinkPad X1 Carbon Gen 9（2021）上的一次完整安装与日常使用过程，带有个人取舍，不代表唯一或最佳实践。详细信息请参考https://wiki.archlinuxcn.org/
{% endnote %}

# Archlinux安装——UEFI 全盘加密（btrfs LUKS） 安全启动（systemd-boot UKI） TPM2自动解锁 基于ThinkPad X1 Carbon Gen 9（2021）

## 0 这套架构在解决什么问题

在动手之前，有必要先理清整套配置的逻辑。全盘加密、安全启动、UKI 与 TPM2 这四样东西并不是各自独立的功能堆叠，而是环环相扣、彼此补位的：

- **LUKS 全盘加密** 解决的是"设备丢失或被盗"——硬盘一旦离开本机，就只是一堆无法读取的密文。代价是每次开机都要手动输入一长串解密密码。
- **TPM2 自动解锁** 把这把密码交给主板上的 TPM 芯片保管，开机自动放行，省去手输。但它随即带来一个新问题：如果有人物理接触机器、替换了内核或往引导链里塞了东西，TPM 是否还会乖乖交出钥匙？
- **安全启动 + UKI（Measured Boot）** 正是用来堵这个洞。UKI 把内核、initramfs 与启动参数打包成单个文件，并用你自己的密钥签名；开机时 TPM 会先核对整条引导链的度量值（PCR），只要有任何一环被改动，度量值就对不上，TPM 拒绝解锁，自动回退到手动输入密码。
- 三者合起来的效果是：**平时无感自动开机，引导链一旦被篡改就降级到密码保护，硬盘离机则完全无法读取。**

**本文环境**：

- **硬件**：ThinkPad X1 Carbon Gen 9（2021，i7-1185G7 Tiger Lake 4C8T + Iris Xe 核显，32G 内存，512G NVMe）；无线 Intel Wi-Fi 6 AX201 + 蓝牙，Quectel EM05-CE 4G 模组，Synaptics 指纹（06cb:00fc），Syntek 摄像头，Thunderbolt 4 ×2
- **系统**：Arch Linux + KDE Plasma (Wayland) + SDDM
- **存储**：LUKS2 全盘加密 → btrfs（`compress=zstd:1`，子卷 `@` `@home` `@var_cache` `@var_log` `@root` `@swap` `@snapshots`）+ snapper 快照
- **内存/交换**：zram（8G，zstd）
- **引导**：systemd-boot + UKI（Measured Boot）+ Secure Boot（sbctl 自管密钥，保留微软厂商密钥）+ TPM2 自动解锁 LUKS
- **网络**：NetworkManager（4G 走 ModemManager，默认关闭）

## 1 基础环境准备

这一节处理安装前的准备工作：联网、对时、配置镜像源，都是后续 pacstrap 下载软件包的前提，没有难点，但每一步都不能少。

进入 Arch Linux 安装镜像后：

**1. 关闭 reflector.service**，以避免它在后台自动更改镜像源、干扰网络速度

```bash
systemctl stop reflector.service
```

**2. 检查启动模式为 EFI**

```bash
ls /sys/firmware/efi/efivars
```

**3. 联网**

```bash
iwctl                              # 进入交互式命令行
device list                        # 列出无线网卡设备名，如无线网卡名为 wlan0
station wlan0 scan                 # 扫描网络
station wlan0 get-networks         # 列出所有 wifi 网络
station wlan0 connect wifi-name    # 进行连接，注意这里无法输入中文，回车后输入密码即可
exit                               # 连接成功后退出
```

若遇到网卡锁定问题：

```bash
rfkill list                # 查看无线连接是否被禁用 (blocked: yes)
ip link set wlan0 up       # 如无线网卡名为 wlan0
```

若看到类似 `Operation not possible due to RF-kill` 的报错，继续尝试 `rfkill unblock wifi` 来解锁无线网卡。

如果是虚拟机没有网络连接，检查虚拟机软件设置中的桥接网卡是不是与物理机联网网卡对应。

使用 `ping www.bilibili.com` 测试网络连通性。

**4. 系统时间同步**

```bash
timedatectl set-ntp true    # 将系统时间与网络时间进行同步
timedatectl status          # 检查服务状态
```

**5. 配置软件源**

```bash
vim /etc/pacman.d/mirrorlist
```

在文件顶部增加以下内容：

```conf
Server = https://mirrors.ustc.edu.cn/archlinux/$repo/os/$arch  # 中国科学技术大学开源镜像站
```

## 2 存储分区与加密

本节完成全盘加密的底层铺设：先用 GPT 划分 EFI 与主分区，再对主分区做 LUKS2 加密，最后在解密后的设备上建立 btrfs 与子卷。后文所有的快照与回滚，都依赖这里的子卷划分。

**1. 分区**

```bash
lsblk      # 显示当前分区情况
cfdisk     # 分区工具
```

采用 GPT 分区表，划分 512M 作为 EFI 系统分区，剩余空间全部分配为 Linux 文件系统。

**2. 加密分区**

```bash
cryptsetup luksFormat --type luks2 /dev/nvme0n1p2   # 对主分区进行 LUKS2 标准的加密
cryptsetup open /dev/nvme0n1p2 linuxroot            # 解密并映射该分区为 linuxroot
```

{% note warning %}
**关于 SSD TRIM（discard）**：如果希望 TRIM 指令能穿透 LUKS 传到 SSD（延长寿命、保持性能），需要在内核 cmdline 中加上 `rd.luks.options=discard`（见 4.2），并启用 `fstrim.timer`（见第 8 节）。不过要清楚，这会带来轻微的安全权衡——攻击者可据此推断哪些块未被使用、大致判断文件系统类型。个人笔记本通常可以接受；介意的话就别开。
{% endnote %}

**3. 建立文件系统**

```bash
mkfs.vfat -F32 -n EFI /dev/nvme0n1p1                # EFI 分区，格式为 vfat
mkfs.btrfs -f -L linuxroot /dev/mapper/linuxroot    # linuxroot 分区，格式为 btrfs

mount /dev/mapper/linuxroot /mnt                    # 挂载 linuxroot 至 mnt

# 合理的子卷划分隔离系统与用户数据，有利于配合未来的系统快照与回滚，仅供参考
btrfs subvolume create /mnt/@           # @（根目录）子卷
btrfs subvolume create /mnt/@home       # home 子卷
btrfs subvolume create /mnt/@var_cache  # var_cache 子卷
btrfs subvolume create /mnt/@var_log    # var_log 子卷
btrfs subvolume create /mnt/@root       # root 子卷
btrfs subvolume create /mnt/@swap       # swap 子卷

btrfs subvolume list /mnt               # 列出所有子卷，检查

umount /mnt                             # 取消挂载

# 挂载所有子卷，启用 zstd:1 透明压缩以优化 I/O 性能
mount -t btrfs -o subvol=@,compress=zstd:1 -m /dev/mapper/linuxroot /mnt
mount -t btrfs -o subvol=@home,compress=zstd:1 -m /dev/mapper/linuxroot /mnt/home
mount -t btrfs -o subvol=@var_cache,compress=zstd:1 -m /dev/mapper/linuxroot /mnt/var/cache
mount -t btrfs -o subvol=@var_log,compress=zstd:1 -m /dev/mapper/linuxroot /mnt/var/log
mount -t btrfs -o subvol=@root,compress=zstd:1 -m /dev/mapper/linuxroot /mnt/root
mount -t btrfs -o subvol=@swap,compress=zstd:1 -m /dev/mapper/linuxroot /mnt/swap

mount -m /dev/nvme0n1p1 /mnt/efi        # 挂载 EFI 分区
```

## 3 核心系统安装与基础配置

加密与文件系统就绪后，这一节用 pacstrap 把基础系统装进去，并完成时区、locale、主机名等最基本的本地化配置。

**1. 设置键盘映射为 US**

```bash
mkdir /mnt/etc
echo "KEYMAP=us" >> /mnt/etc/vconsole.conf
```

**2. 使用 pacstrap 安装基础系统、内核、微代码、加密与网络工具**

```bash
pacstrap -K /mnt base base-devel linux linux-firmware intel-ucode util-linux vim cryptsetup btrfs-progs sbctl networkmanager sudo
```

**3. 生成挂载表 fstab**

```bash
genfstab -U /mnt > /mnt/etc/fstab
```

**4. 进入系统终端**

```bash
arch-chroot /mnt    # 切换进入新系统环境
passwd              # 设置 root 密码
```

**5. 本地化**

```bash
ln -sf /usr/share/zoneinfo/Asia/Shanghai /etc/localtime   # 设置时区（按需改为 Pacific/Auckland 等）
hwclock --systohc                                         # 同步硬件时钟
```

编辑 `/etc/locale.gen`，取消 `en_GB.UTF-8 UTF-8` 和其他需要的区域设置前的注释。

执行 `locale-gen` 生成 locale 信息。

创建并编辑 `locale.conf`，设定 LANG 变量：

```bash
echo "LANG=en_GB.UTF-8" > /etc/locale.conf
```

这里设置的 LANG 变量需与 locale 设置一致，否则会出现以下错误：
`Cannot set LC_CTYPE to default locale: No such file or directory`

**6. 主机名设定**

```bash
echo "archlinux" > /etc/hostname
```

## 4 内核引导

本节的目标，是把内核、initramfs 和内核参数合并成一个统一内核映像（UKI），放进 ESP 由 systemd-boot 直接加载。之所以要合成单个文件，是因为只有这样它才能在后面被安全启动整体签名、被 TPM 整体度量——这是第 5、6 节的前提。

**1. mkinitcpio Hooks 配置**

编辑 `/etc/mkinitcpio.conf`，由于采用了 systemd 引导架构，修改为以下配置：

```conf
HOOKS=(base systemd autodetect microcode modconf kms keyboard sd-vconsole block sd-encrypt filesystems fsck)
```

{% note info %}
说明：systemd 方案下，`keyboard` 负责加载键盘硬件模块（用于在解密界面输入密码），`sd-vconsole` 负责读取 `/etc/vconsole.conf` 设置控制台键位与字体。两者已经足够，**不需要再叠加旧的 `keymap` / `consolefont` 钩子**——那是非 systemd 方案的等价物，重复加上去只是冗余。
{% endnote %}

**2. 统一内核映像（UKI）配置**

```bash
blkid    # 查看各分区 UUID
```

配置 LUKS 解密与 Btrfs 根目录挂载参数，编辑 `/etc/kernel/cmdline`：

```conf
rd.luks.name=<LUKS分区UUID>=linuxroot root=/dev/mapper/linuxroot rootfstype=btrfs rootflags=subvol=/@ rd.luks.options=discard rw loglevel=3
```

{% note warning %}
`<LUKS分区UUID>` 要替换成上一步 `blkid` 查到的 **加密分区本身**（`/dev/nvme0n1p2`）的 UUID，注意不是 btrfs 文件系统的 UUID，也不要把字面的 `UUID` 直接留在里面。`rd.luks.options=discard` 用于打开 TRIM 穿透（安全权衡见第 2 节），不想开就删掉这一段。
{% endnote %}

**3. mkinitcpio preset 配置**

编辑 `/etc/mkinitcpio.d/linux.preset`：

```conf
ALL_config="/etc/mkinitcpio.conf"
ALL_kver="/boot/vmlinuz-linux"

PRESETS=('default')
#PRESETS=('default' 'fallback')

#default_config="/etc/mkinitcpio.conf"
#default_image="/boot/initramfs-linux.img"
default_uki="/efi/EFI/Linux/arch-linux.efi"
default_options="--splash /usr/share/systemd/bootctl/splash-arch.bmp"

#fallback_config="/etc/mkinitcpio.conf"
#fallback_image="/boot/initramfs-linux-fallback.img"
#fallback_uki="/efi/EFI/Linux/arch-linux-fallback.efi"
#fallback_options="-S autodetect"
```

```bash
mkinitcpio -P    # 生成映像
```

**4. 系统环境配置**

```bash
systemctl mask systemd-networkd      # 屏蔽底层网络守护进程
systemctl enable NetworkManager      # 启用现代网络管理器
bootctl install --esp-path=/efi      # 安装引导加载程序
sync                                 # 将内存缓冲写入硬盘
systemctl reboot                     # 重启系统
```

至此我们已经可以正常进入系统。

## 5 安全启动

这一节用 sbctl 生成并注册属于自己的安全启动密钥，再给引导链上的每个 `.efi` 文件签名。完成后，固件只会放行你亲手签过的引导程序，任何被替换或篡改的文件都无法启动。

{% note danger %}
**强烈建议在操作前用 `efi-readvar` 备份现有的 PK、KEK、db、dbx 密钥。** `efi-readvar` 来自 `efitools` 包，没有就先 `pacman -S efitools`。
{% endnote %}

**1. 备份当前变量**

```bash
efi-readvar -v PK  -o old_PK.esl
efi-readvar -v KEK -o old_KEK.esl
efi-readvar -v db  -o old_db.esl
efi-readvar -v dbx -o old_dbx.esl
```

**2. 生成并注册自定义安全启动密钥**

```bash
sbctl status
sbctl create-keys          # 生成密钥
sbctl enroll-keys -m       # 注册密钥（-m 保留微软厂商密钥，便于第三方 Option ROM / 双系统）
sbctl verify
sbctl sign -s /efi/EFI/BOOT/BOOTX64.EFI
sbctl sign -s /efi/EFI/Linux/arch-linux.efi
sbctl sign -s /efi/EFI/systemd-bootx64.efi    # 数字签名
```

{% note info %}
`sbctl enroll-keys` 要求固件处于 **Setup Mode**（已清空 PK）。如果报错，先进 BIOS 把 Secure Boot 切到 Setup Mode 或清除现有密钥，再回来执行。
{% endnote %}

**3. 使用 pacman 钩子自动签署**

sbctl 默认带有 pacman 钩子，可在日后内核更新时自动重签名。

需要留意的是：如果通过 systemd-boot 启用了 `systemd-boot-update.service`，引导加载程序只会在重启后升级，导致 sbctl 的 pacman 钩子来不及签署新文件。变通的办法是直接在 `/usr/lib/` 里签署引导加载程序——这样 `bootctl install` 与 `update` 会自动识别并把 `.efi.signed`（如果存在）复制到 ESP，而不是普通的 `.efi`：

```bash
sbctl sign -s -o /usr/lib/systemd/boot/efi/systemd-bootx64.efi.signed /usr/lib/systemd/boot/efi/systemd-bootx64.efi
```

{% note info %}
同样的思路也适用于 **fwupd 的胶囊更新引导器**：Secure Boot 开启后，fwupd 找的是签过名的 `.signed` 文件，自签密钥的机器需要手动签一次，否则联想固件更新会失败——具体做法见第 8 节（固件更新 fwupd）。
{% endnote %}

## 6 TPM2.0 自动解锁

全盘加密带来的唯一不便，就是每次开机都要手输一长串密码。这一节把解密密钥封存进主板的 TPM2 芯片，让引导链未被篡改时自动放行——平时无感开机，出了问题再回退到密码。

{% note danger %}
**第一步永远是先生成恢复密钥。** TPM 与密码同时出问题时，这是唯一的保底——这一点下面会再次印证。
{% endnote %}

**1. 生成恢复密钥以防 TPM 模块故障 / 策略失效**

```bash
systemd-cryptenroll --recovery-key /dev/nvme0n1p2
```

**2. 将 LUKS 槽位注册到 TPM2 设备**

```bash
systemd-cryptenroll --tpm2-device=auto /dev/nvme0n1p2
systemd-cryptenroll /dev/nvme0n1p2                         # 列出当前已注册的密钥槽位
# 如需清理某个空槽位：
# systemd-cryptenroll /dev/nvme0n1p2 --wipe-slot=empty
```

**关于 PCR 7：一个迟早会遇到的现象。** `systemd-cryptenroll --tpm2-device=auto` 默认把密钥绑定到 **PCR 7**，也就是 Secure Boot 状态。这意味着某天 fwupd 推送一次 UEFI dbx 更新（Secure Boot 吊销数据库）之后，由于 dbx 属于 PCR 7 度量内容的一部分，PCR 7 一变，TPM 就按设计拒绝放钥匙，开机重新要求输入 LUKS 密码。日志大致是：

```
systemd-cryptsetup: TPM policy does not match current system state.
Either system has been tampered with or policy out-of-date
```

这是防篡改机制的正常反应。用现有 LUKS 密码授权后重新绑定即可：

```bash
sudo systemd-cryptenroll --wipe-slot=tpm2 --tpm2-device=auto --tpm2-pcrs=7 /dev/nvme0n1p2
```

一个实测规律值得记住：**dbx 更新或 Secure Boot 密钥变动会让自动解锁失效**（改了 PCR 7），而 **BIOS / EC / Intel ME 固件升级不会**（只改 PCR 0/2，本机实测 BIOS 1.77 升级后无需重绑）。这也正是上面第一步恢复密钥的意义所在——它是 TPM 和密码都出问题时的最后保底。

---

## 7 进阶系统配置

系统已经能正常使用，这一节补齐日常所需的配置：网络、用户、快照、桌面环境与输入法。

**1. 网络配置**

```bash
nmcli dev wifi list                                          # 显示附近的 Wi-Fi 网络
nmcli dev wifi connect "Wi-Fi名（SSID）" password "网络密码"  # 连接指定的无线网络
# 如果上面报错运行以下命令
nmcli dev wifi connect "Wi-Fi名（SSID）" --ask
nmtui                                                        # 图形界面
```

**2. 添加新用户**

```bash
useradd -G wheel -m newUser                                  # 添加 newUser 用户
echo "newUser ALL=(ALL:ALL) ALL" >> /etc/sudoers.d/newUser   # 给予 sudo 权限
passwd newUser                                               # 修改密码
```

**3. 安装 fastfetch 查看系统信息**

```bash
pacman -S fastfetch
```

**4. 配置 snapper 快照**

需要专门创建一个 `@snapshots` 子卷挂载至 `/.snapshots`，这样在回滚根目录时才不会把快照本身一起丢掉。

```bash
pacman -S snapper snap-pac                # 安装软件包
snapper -c snap create-config /           # 新建一个名为 snap 的配置
btrfs subvolume delete /.snapshots        # 删除默认配置的快照子卷
mkdir /.snapshots                         # 在根目录新建快照保存文件夹
mount /dev/mapper/linuxroot /mnt          # 把顶层子卷挂载到一个临时位置
btrfs subvolume create /mnt/@snapshots    # 新建快照存放子卷
umount /mnt
mount -t btrfs -o subvol=@snapshots,compress=zstd:1 -m /dev/mapper/linuxroot /.snapshots
chown :wheel /.snapshots                  # 权限管理
chmod 750 /.snapshots                     # 权限管理
```

在 `/etc/fstab` 中补充挂载条目（UUID 换成自己的 btrfs 文件系统 UUID）：

```conf
# <设备>  <挂载点>  <类型>  <参数>
UUID=aacd8c72-ee57-41f2-8122-e957967de330  /.snapshots btrfs rw,relatime,compress=zstd:1,ssd,space_cache=v2,subvol=/@snapshots 0 0
```

编辑快照配置 `/etc/snapper/configs/snap`：

```conf
# 1. 权限设置：允许 wheel 组用户管理快照
ALLOW_GROUPS="wheel"

# 2. 自动快照开关
TIMELINE_CREATE="yes"     # 开启时间线快照（每小时自动打）
TIMELINE_CLEANUP="yes"    # 开启清理服务（必须开，否则只增不减）

# 3. 保留策略（最关键部分，默认值太多了，建议大幅减少）
TIMELINE_MIN_AGE="1800"        # 至少保留多久不被删（秒），1800=30 分钟
TIMELINE_LIMIT_HOURLY="5"      # 每小时保留 5 个（覆盖过去 5 小时）
TIMELINE_LIMIT_DAILY="7"       # 每天保留 7 个（覆盖过去一周）
TIMELINE_LIMIT_WEEKLY="0"      # 周/月/年一般设 0，个人电脑很少回滚到一年前，且占空间巨大
TIMELINE_LIMIT_MONTHLY="0"
TIMELINE_LIMIT_YEARLY="0"

# 4. 手动 / pacman 快照数量限制
NUMBER_CLEANUP="yes"
NUMBER_LIMIT="50"
NUMBER_LIMIT_IMPORTANT="10"
```

```bash
systemctl enable --now snapper-timeline.timer    # 启用定时快照（只想要 pacman 自动快照可不开）
systemctl enable --now snapper-cleanup.timer     # 启用自动清理（不开快照只增不减）
snapper -c snap create -d "My First Snapshot"    # 手动创建快照
snapper -c snap list                             # 快照列表
```

**5. 安装并加固 ssh 服务**

```bash
sudo pacman -S openssh
```

sshd 默认是"监听 0.0.0.0:22 + 允许密码登录"，在公网或多设备环境下务必先做基础加固：仅密钥登录、禁用 root、限制重试。新建一个 drop-in 配置文件：

```conf
# /etc/ssh/sshd_config.d/10-hardening.conf
PasswordAuthentication no
AuthenticationMethods publickey
PermitRootLogin no
MaxAuthTries 3
LoginGraceTime 30
X11Forwarding no
```

**改之前一定要先确认密钥能登录，顺序不能错，否则会把自己锁在门外**：

1. 先从客户端 `ssh-copy-id` 部署公钥，确认服务器上 `~/.ssh/authorized_keys` 就位（目录 700 / 文件 600）
2. 写入上面的配置后用 `sshd -t` 校验，报错就先别动
3. `systemctl reload sshd`（reload 不会断开当前连接）
4. **保持当前会话不要关**，另开一个窗口用密钥登录成功，才算完成

确认无误后启用服务：

```bash
sudo systemctl enable --now sshd
```

**6. 安装桌面环境**

```bash
sudo pacman -S plasma plasma-workspace kde-applications
```

**7. 中文输入法**

```bash
sudo pacman -S fcitx5-im fcitx5-chinese-addons
```

KDE Wayland 下配置 `/etc/environment`：

```conf
XMODIFIERS=@im=fcitx
```

安装词库：

```bash
sudo pacman -S fcitx5-pinyin-zhwiki
```

**8. zsh 配置**

```bash
chsh -s /usr/bin/zsh    # 将 Zsh 设置为当前用户的默认 Shell
zsh                     # 启动 Zsh（如果尚未启动）
sudo pacman -S zsh-autosuggestions zsh-completions zsh-history-substring-search zsh-syntax-highlighting
```

> 插件装上只是第一步：没有 `compinit`、或插件加载顺序不对（autosuggestions → syntax-highlighting → history-substring-search），这些插件都等于白装。完整的 `.zshrc` 与配置思路内容较多，单独整理在了 [我的 zsh 配置](https://github.com/CatWhiteAngel/dotfiles/tree/main/zsh)里。

**9. 收紧 EFI 分区权限（可选）**

`genfstab` 生成的 EFI 挂载条目默认是 `fmask=0022`，意味着所有用户都能读取 ESP 里的引导文件。想收紧到只有 root 可读，编辑 `/etc/fstab`，把 EFI 那一行的参数改成：

```conf
fmask=0137,dmask=0027
```

**注意：这个改动必须改 fstab 然后重启才生效。** vfat 的 `fmask/dmask` 是超级块级别的选项，在运行中的系统上直接 `mount -o remount` 或重新挂载都不会生效（旧的超级块会被各种服务的挂载命名空间占用、静默复用，新参数被忽略）。别在运行时折腾，改好 fstab 重启即可。

## 8 硬件适配（ThinkPad X1 Carbon Gen 9）

https://wiki.archlinux.org/title/Lenovo_ThinkPad_X1_Carbon_(Gen_9)

以上流程对大多数机器通用，这一节按"不装就用不了 → 按需 → 开箱即用"的顺序，逐项列出本机各部件实测后需要的包与配置。

可以先把硬件相关的包一次装齐，再看下面每项的说明与验证：

```bash
sudo pacman -S --needed \
  intel-ucode \
  sof-firmware alsa-ucm-conf \
  mesa intel-media-driver vulkan-intel \
  linux-firmware wireless-regdb \
  networkmanager modemmanager \
  bluez bluez-utils \
  fprintd \
  fwupd
```

**1. 声音（必需，否则完全无声）**

Tiger Lake 的声卡走 Sound Open Firmware（SOF），不装就 **没有任何声音输出**：

```bash
sudo pacman -S sof-firmware alsa-ucm-conf
```

驱动是 `sof-audio-pci-intel-tgl`，声卡名 `sof-hda-dsp`，`cat /proc/asound/cards` 应能看到 `sofhdadsp`。内置的四阵列麦克风（DMIC）也归 SOF 管，装好 `sof-firmware` + `alsa-ucm-conf` 后通常即可使用；个别情况下麦克风识别不出来，是 DMIC 与 HDA codec 的加载顺序问题，可参考 Arch Wiki 的 Gen 9 页面麦克风小节处理。

外放偏闷，可选装 `easyeffects` 并套用预设包里的 "Laptop" 预设改善：

```bash
sudo pacman -S easyeffects
```

**2. CPU 微码（必需）**

```bash
sudo pacman -S intel-ucode
```

通过第 4 节 HOOKS 里的 `microcode` 早加载。调频驱动是 `intel_pstate`，HWP（硬件管理 P-states）已生效，`cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_driver` 应为 `intel_pstate`。dmesg 里没有 "microcode: updated early" 也属正常——说明 BIOS 自带微码已不低于包里的版本。

**3. 核显 / 视频加速（必需）**

```bash
sudo pacman -S mesa intel-media-driver vulkan-intel
```

内核驱动用默认的 `i915` 即可，DMC/GuC/HuC 固件随 `linux-firmware` 自动加载，**无需折腾 xe**。VA-API 走 **iHD**（`intel-media-driver`），不要装老的 `libva-intel-driver`（i965，那是给老核显的）。验证：`vainfo | grep "Driver version"` 应显示 Intel iHD。

**4. Wi-Fi（AX201）+ 无线监管库（必需）**

Wi-Fi 驱动 `iwlwifi` 与固件随 `linux-firmware` 自带，但 **`wireless-regdb` 很容易漏装**：

```bash
sudo pacman -S linux-firmware wireless-regdb
```

缺了它，dmesg 会报 `cfg80211: failed to load regulatory.db`，监管域退回 `country 00`（信道与发射功率不受正确约束）。装上重启后用 `iw reg get` 确认不再是 `country 00`。（NetworkManager 的安装与连接见第 7 节。）

**5. 蓝牙（AX201）（必需）**

```bash
sudo pacman -S bluez bluez-utils
sudo systemctl enable --now bluetooth
```

固件随 `linux-firmware`（Intel ibt 系列）自动加载。`bluez-utils` 提供 `bluetoothctl`，**也容易漏装**。之后在 KDE 系统托盘的蓝牙图标里配对即可。

**6. 电池充电阈值（ThinkPad 特色，延长电池寿命）**

内核的 `thinkpad_acpi` 直接暴露 sysfs 接口，不需要 TLP 全家桶。写一个 oneshot 服务在开机时设置即可（本机用 75/80）：

```ini
# /etc/systemd/system/battery-charge-threshold.service
[Unit]
Description=Set ThinkPad battery charge thresholds (75/80)
After=multi-user.target

[Service]
Type=oneshot
ExecStart=/bin/sh -c 'echo 75 > /sys/class/power_supply/BAT0/charge_control_start_threshold; echo 80 > /sys/class/power_supply/BAT0/charge_control_end_threshold'

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now battery-charge-threshold.service
```

**7. 电源管理**

KDE 生态选 `power-profiles-daemon`（Plasma 电池菜单里直接集成三档调度）：

```bash
sudo pacman -S power-profiles-daemon
```

CPU 调度走 intel_pstate 的 `powersave` governor + `balance_performance` EPP，无需额外配置。注意 **TLP 与 PPD 二选一，不要同时装**。

**8. 固件更新：fwupd**

```bash
sudo pacman -S fwupd
```

联想把 BIOS / EC / Intel ME / UEFI dbx 都推到了 LVFS，用 Discover 或 `fwupdmgr` 即可直接升级。

不过开启 Secure Boot 自签密钥的机器这里有个坑：UEFI 胶囊更新需要重启进入 fwupd 的 EFI 引导器来刷固件，而 Secure Boot 开启时 fwupd 找的是 **签过名的** `.signed` 文件，Arch 不会替你签（密钥在你手里），于是固件更新会报错 `fwupdx64.efi.signed cannot be found`。手动签一次即可（`-s` 记入 sbctl 数据库，以后 fwupd 包升级会自动重签，一劳永逸）：

```bash
sudo sbctl sign -s -o /usr/lib/fwupd/efi/fwupdx64.efi.signed /usr/lib/fwupd/efi/fwupdx64.efi
```

若机器没有 shim，再在 `/etc/fwupd/fwupd.conf` 追加：

```conf
[uefi_capsule]
DisableShimForSecureBoot=true
```

之后固件即可正常升级。提醒：**刷 EC 必须插着电源**；过程中会自动重启多次，看到 Lenovo logo 进度条耐心等就好。

**9. 指纹识别（可选）**

本机的指纹模块是 Synaptics Prometheus（`06cb:00fc`），libfprint 原生支持：

```bash
sudo pacman -S fprintd
fprintd-enroll        # 录入指纹
```

`fprintd` 是 dbus 激活的，不用 enable 服务。若想让登录、sudo、解锁屏幕也走指纹，再在 `/etc/pam.d/` 的相应文件里加 `pam_fprintd.so`（具体见 Arch Wiki 的 fprint 词条）。验证：`lsusb -d 06cb:00fc` 能看到设备。若型号不同，`fprintd-enroll` 报错就说明你的批次暂未被 libfprint 支持。

**10. WWAN 4G 模组（按需）**

本机带 Quectel EM05-CE 蜂窝模组，默认保持关闭，需要插 SIM 上网时再启用：

```bash
sudo pacman -S modemmanager
# 需要时再开：
# sudo systemctl enable --now ModemManager
```

EM05-CE 在 Linux 下基本开箱即用，启用 ModemManager 后用 `mmcli -L` 能看到模组，NetworkManager 可直接管理蜂窝连接。（注意：部分 Fibocom 模组需要额外的 FCC unlock，EM05-CE 不需要。）

**11. Thunderbolt 4 / USB4（开箱即用）**

`thunderbolt` 驱动已自动绑定，无需额外包。若想对外接 TB 设备做授权管理，可选装 `bolt`（用 `boltctl` 管理授权）。

**12. 屏幕亮度 / 旋转传感器**

```bash
sudo pacman -S iio-sensor-proxy
```

提供环境光传感器（自动亮度）与加速度计（自动旋转）支持，KDE 会自动接入。

**13. 摄像头 / TrackPoint / 触控板（开箱即用）**

摄像头（Syntek）走 `uvcvideo`，TrackPoint 与触控板由 `psmouse` + libinput 处理，都不用额外配置。TrackPoint 默认灵敏度若不顺手，可改 `/sys/devices/platform/i8042/serio*/sensitivity`（取值 0–255，60 左右是个不错的起点）。

**14. zram（内存压缩交换）**

```bash
sudo pacman -S zram-generator
```

```ini
# /etc/systemd/zram-generator.conf
[zram0]
zram-size = 8192
compression-algorithm = zstd
```

配合官方推荐的内核参数：

```ini
# /etc/sysctl.d/99-zram.conf
vm.swappiness = 180
vm.watermark_boost_factor = 0
vm.watermark_scale_factor = 125
vm.page-cluster = 0
```

**15. SSD：TRIM 穿透 LUKS**

内核 cmdline 已加 `rd.luks.options=discard`（见 4.2），再启用定时 TRIM：

```bash
sudo systemctl enable --now fstrim.timer
```

**16. 散热：不要装 thermald**

这台机器 **不要装 `thermald`**——散热已由三层自管，实测在跑：HWP 硬件 P-states 让 CPU 按 PL1/PL2/Tjmax 自主降频；DPTF 固件散热（`proc_thermal` 驱动 + ACPI `INT3400` 热区，Lenovo BIOS 实现了完整动态热框架）；以及 ThinkPad EC 独立控制风扇曲线。thermald 只对没有 HWP、OEM 固件散热又差的老机型才有意义，本机安装后会提示无法启用服务。

**17. 其他细节**

- **睡眠（挂起）方式**：Tiger Lake 这代普遍走 s2idle（Windows modern standby），而非传统 S3；Lenovo 官方也建议现代 Intel 平台用这种方式。`cat /sys/power/mem_sleep` 可看当前在用的（方括号里那个）。若挂起耗电偏高，优先升级 BIOS，它对 s0ix 残留功耗有改善。
- BIOS（firmware）阶段本机就要约 10 秒，想缩短可去 BIOS 里关掉不用的启动项。

启动耗时参考：firmware 10.3s（BIOS 层面）+ loader 2.4s + kernel 1s + initrd 3.7s + userspace 6.7s。

**验证速查**

装完之后，这几条命令可以快速核对各部件状态：

```bash
lspci -k                              # 各 PCI 设备的内核驱动绑定
lsusb                                 # USB 设备（WWAN / 指纹 / 摄像头 / 蓝牙）
sudo dmesg | grep -iE "firmware|fail" # 固件加载与错误告警
cat /proc/asound/cards                # 声卡
vainfo | grep "Driver version"        # 核显 VA-API
iw reg get                            # Wi-Fi 监管域
mmcli -L                              # WWAN 模组（启用 ModemManager 后）
```

---

## 结语

这套配置乍看环节很多，但拆开来每一步都不复杂，真正的价值在于它们组合起来之后那种"平时无感、出事兜底"的安全感。安装过程难免踩坑，卡住了多查 Arch Wiki、多看日志，绝大多数问题都能定位下来。如有出入或更好的做法，欢迎在评论区指正。

**最后祝各位折腾顺利。**

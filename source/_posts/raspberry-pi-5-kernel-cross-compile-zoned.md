---
title: 树莓派 5 内核交叉编译速通——为 HM-SMR 硬盘启用 zoned 支持
date: 2026-07-23 18:31:00
tags: [Raspberry Pi, Kernel Compilation, Cross Compilation, SMR]
categories: [Hardware]
---

# 树莓派 5 内核交叉编译速通——为 HM-SMR 硬盘启用 zoned 支持

这是[Ultrastar DC HC620 分析与实战——树莓派 5 驱动主机管理式 SMR 硬盘](https://www.catwhiteangel.com/hc620-hm-smr-raspberry-pi-5/)的续篇。前文提过，Raspberry Pi OS 官方内核的 `bcm2712_defconfig` 没有启用 `CONFIG_BLK_DEV_ZONED`，主机管理式叠瓦（Host-Managed SMR，HM-SMR）盘接上以后，内核会直接拒绝为它创建块设备节点。所以想用 HC620，自己编译内核这一步省不掉。

本文的做法是在一台 x86_64 的 Ubuntu Desktop 26.04 虚拟机里交叉编译树莓派内核，打好包传到 Pi 5 上安装。官方内核、设备树和 `cmdline.txt` 全部原样保留，只在 `config.txt` 末尾加一行 `os_prefix` 做启动选择，回滚时删掉这一行重启就行。
<!-- more -->

## 环境

| 角色 | 配置 |
| --- | --- |
| 编译机 | Ubuntu Desktop 26.04 虚拟机，x86_64，8 vCPU / 8 GB 内存 |
| 目标机 | Raspberry Pi 5，Raspberry Pi OS（64-bit） |
| 内核源码 | `raspberrypi/linux`，分支 `rpi-6.18.y` |

分支跟着目标机走，不用特意挑。在 Pi 上执行 `uname -r`，看当前内核属于哪个系列，目标机为 `6.18.34+rpt-rpi-2712`，选同系列的分支即可。本文写作时，`rpi-6.18.y` 的最新版本是 `6.18.39 Commit 820b5b663`。

## 1 编译机准备

装工具链和内核构建依赖：

```bash
sudo apt update
sudo apt install git bc bison flex libssl-dev make libc6-dev \
  libncurses-dev crossbuild-essential-arm64
```

`crossbuild-essential-arm64` 会带上 `aarch64-linux-gnu-gcc` 全套交叉工具链。

## 2 获取源码

只要当前分支最新提交，浅克隆省时间省空间：

```bash
git clone --depth=1 --branch rpi-6.18.y https://github.com/raspberrypi/linux.git
cd linux
git rev-parse --short HEAD   # 记下提交号，真机结果对应确切源码
```

## 3 配置

先应用官方默认配置，再用 `scripts/config` 脚本修改差异。这种方式比在 menuconfig 中逐项翻菜单更容易复现，后续跟版重编时直接重放这几条命令即可。

```bash
make ARCH=arm64 CROSS_COMPILE=aarch64-linux-gnu- bcm2712_defconfig

./scripts/config \
  --enable  CONFIG_BLK_DEV_ZONED \
  --module  CONFIG_DM_ZONED \
  --module  CONFIG_ZONEFS_FS \
  --module  CONFIG_BTRFS_FS \
  --disable CONFIG_ARM64_16K_PAGES \
  --enable  CONFIG_ARM64_4K_PAGES \
  --set-str CONFIG_LOCALVERSION "-v8-4k-zoned"

make ARCH=arm64 CROSS_COMPILE=aarch64-linux-gnu- olddefconfig   # olddefconfig 将其余选项按依赖规则补齐默认值，全程非交互
```

各项配置的作用如下：`CONFIG_BLK_DEV_ZONED` 是通用块层的 zoned 支持开关，启用后 SCSI 磁盘驱动中的 ZBC（Zoned Block Commands）支持会随之构建。`CONFIG_DM_ZONED` 与 `CONFIG_ZONEFS_FS` 是两条可选的上层使用路径，本文编译为模块，按需加载。btrfs 的 zoned 模式没有单独的配置项，只需启用普通的 `CONFIG_BTRFS_FS`，本文同样显式设为模块，避免依赖未来版本的 defconfig。

页大小方面，Pi 5 的 `bcm2712_defconfig` 默认使用 16K 页。启用 zoned block support 本身并不要求改成 4K，本文仍选择 4K 页。除了与前文已验证的 btrfs、dm-zoned 和用户态工具环境保持一致、减少排障时的变量之外，还有两个更实际的考虑。

先看 16K sectorsize 的情况。常规配置的 6.18 系内核中，16K 页下的 Btrfs 支持 4K 和 16K 两种 sectorsize。文件系统一旦使用 16K sectorsize，普通的 4K 页内核就无法直接挂载，发生故障时不能把硬盘接到常见的 x86_64 PC 上直接救援。Linux 6.18 开始提供“block size 大于 page size”的基础支持，启用 `CONFIG_BTRFS_EXPERIMENTAL` 的 4K 页内核可以处理 16K sectorsize，但这条路径仍属实验功能，存在多项限制，不适合作为常规救援手段。

再看 4K sectorsize 的情况。在 16K 页内核上使用 4K sectorsize 时，普通 Btrfs 会进入 subpage 模式。该模式从 Linux 6.15 起移除了实验性警告，到 6.18 已经相对完整并经过测试，但原生 btrfs zoned 与 subpage blocksize 的组合尚未实现。要让 Btrfs 以原生 zoned 模式运行在 HM-SMR 设备上，sectorsize 仍需与内核页大小保持一致。把 Pi 5 内核改成 4K 页后，既可以走原生的 4K sectorsize 路径，也保留了把硬盘接到普通 4K 页 Linux PC 上直接挂载和救援的能力。

如果走 dm-zoned 路径，Btrfs 面对的是 dm-zoned 暴露出来的普通块设备，不会进入原生 btrfs zoned 模式，此时 16K 页加 4K sectorsize 的普通 subpage 路径在 6.18 中已经可用。不过，为了统一前文的三条实验路径并保留跨机器救援的兼容性，本文统一采用 4K 页。保留默认的 16K 页也可行，但需要根据实际使用的原生 btrfs zoned、dm-zoned 或 zonefs 路径分别做实机验证。

`LOCALVERSION` 用于给自编内核设置独立名称，使其模块安装到单独的 `/lib/modules/<kernelrelease>/` 目录中，不与官方内核模块混用。

修改完成后验证一遍，注意确认 16K 页确实已关闭。

```bash
grep -E 'CONFIG_LOCALVERSION=|CONFIG_ARM64_(4K|16K)_PAGES|CONFIG_BLK_DEV_ZONED|CONFIG_DM_ZONED|CONFIG_BTRFS_FS=|CONFIG_ZONEFS_FS' .config
```

预期的关键配置行如下：

```text
CONFIG_LOCALVERSION="-v8-4k-zoned"
CONFIG_ARM64_4K_PAGES=y
# CONFIG_ARM64_16K_PAGES is not set
CONFIG_BLK_DEV_ZONED=y
# CONFIG_BLK_DEV_ZONED_LOOP is not set
CONFIG_DM_ZONED=m
CONFIG_BTRFS_FS=m
CONFIG_ZONEFS_FS=m
```

## 4 编译

```bash
make -j$(nproc) ARCH=arm64 CROSS_COMPILE=aarch64-linux-gnu- Image.gz modules dtbs
```

编译完成后记录完整内核版本号（基础版本 + LOCALVERSION），后续验证环节需要与其对照：

```bash
make -s ARCH=arm64 CROSS_COMPILE=aarch64-linux-gnu- kernelrelease
# 本文实测：6.18.39-v8-4k-zoned+
```

在 8 vCPU / 8 GB 内存的虚拟机上，本次编译用时约 17 分钟。

## 5 打包产物

将自编内核的全部启动产物放入独立的 `zoned/` 目录，后续通过固件的 `os_prefix` 机制按目录整体切换，不覆盖官方内核、设备树、overlays 和 `cmdline.txt`：

```bash
rm -rf dist
mkdir -p dist/firmware/zoned/overlays

make ARCH=arm64 CROSS_COMPILE=aarch64-linux-gnu- \
  INSTALL_MOD_PATH="$PWD/dist" INSTALL_MOD_STRIP=1 modules_install

cp arch/arm64/boot/Image.gz dist/firmware/zoned/kernel_2712.img
cp arch/arm64/boot/dts/broadcom/bcm2712*.dtb dist/firmware/zoned/
cp arch/arm64/boot/dts/overlays/*.dtb* dist/firmware/zoned/overlays/
cp arch/arm64/boot/dts/overlays/README dist/firmware/zoned/overlays/

tar czf pi-kernel-zoned.tar.gz -C dist .
```

`Image.gz` 直接改名后即可作为树莓派固件可引导的内核镜像，固件根据文件内容判断压缩格式，不依赖扩展名。镜像命名为 `kernel_2712.img`，因为这是 Pi 5 固件的默认查找名，配合 `os_prefix` 使用就无需再添加 `kernel=` 配置行。`INSTALL_MOD_STRIP=1` 用于去除模块的调试符号，可以显著减小模块体积。

将压缩包传到 Pi：

```bash
scp pi-kernel-zoned.tar.gz <树莓派用户名>@<树莓派地址>:~/
```

## 6 树莓派上安装

解包并安装。这组命令采用先删后装的方式，首次安装、同版本重编和跟版更新都适用，不会残留旧文件：

```bash
rm -rf dist && mkdir dist
tar xzf pi-kernel-zoned.tar.gz -C dist

KREL=$(basename "$(find dist/lib/modules -mindepth 1 -maxdepth 1 -type d)")
sudo rm -rf "/lib/modules/$KREL"
sudo cp -a "dist/lib/modules/$KREL" /lib/modules/
sudo depmod -a "$KREL"

sudo rm -rf /boot/firmware/zoned
sudo cp -r dist/firmware/zoned /boot/firmware/
sudo cp /boot/firmware/cmdline.txt /boot/firmware/zoned/cmdline.txt
```

`/boot/firmware/config.txt` 末尾追加：

```ini
[all]
os_prefix=zoned/
```

`[all]` 用于清除 config.txt 中此前可能生效的条件过滤段（如 `[cm4]`、`[pi4]`），保证这行配置对 Pi 5 生效。固件会到 `zoned/` 目录中按默认名称查找内核、设备树、overlays 和 `cmdline.txt`，原有的对应文件均保持不变。固件启动时会先检查 `zoned/` 中是否存在预期的内核和设备树，关键文件缺失时会忽略该前缀并回退到原有启动文件。这是一层基本保护，但并不等于事务式更新。如果复制中途断掉，缺失的又只是 overlays 或 `cmdline.txt`，前缀仍可能通过检查，系统会带着不完整的文件启动。因此重启前应当确认关键文件全部就位：

```bash
if test -s /boot/firmware/zoned/kernel_2712.img &&
   test -s /boot/firmware/zoned/bcm2712-rpi-5-b.dtb &&
   test -s /boot/firmware/zoned/cmdline.txt &&
   test -s /boot/firmware/zoned/overlays/README &&
   find /boot/firmware/zoned/overlays -maxdepth 1 -name '*.dtbo' -print -quit | grep -q .
then
  echo "启动文件检查通过"
  sudo sync   # boot 分区是 FAT，写完同步一下再重启更稳妥
else
  echo "启动文件不完整，请勿重启" >&2
fi
```

有两点需要注意。第一，`zoned/cmdline.txt` 是安装时复制的快照，之后只要修改了 `/boot/firmware/cmdline.txt`，例如根分区 PARTUUID、串口控制台、cgroup 或其他内核启动参数，都要重新复制一份到 `zoned/`。第二，本文测试机从 SD 卡上的 ext4 根分区启动，相关存储与文件系统驱动均为内置，实测不需要额外制作 initramfs。如果根分区使用了 btrfs、LUKS、LVM 或特殊存储控制器，或者现有系统本身依赖 initramfs，则需要为自编内核生成匹配的 initramfs 并放入 `zoned/`（`auto_initramfs=1` 时固件按 `kernel_2712.img` 在同目录查找 `initramfs_2712`）。

![](https://img.gulugulublog.com/posts/raspberry-pi-5-kernel-cross-compile-zoned/QQ20260724-211612.png)

不使用 initramfs 引导还存在一个连带问题。内核直接挂载的根文件系统在 `/proc/mounts` 中显示为 `/dev/root`，这并不是一个真实存在的设备节点。Pi OS 默认的 `MODULES=dep` 模式要求 `update-initramfs` 能够解析根设备，因此在运行自编内核期间，任何触发 initramfs 重建的 apt 操作，例如安装带有钩子的软件包或更新官方内核，都会报出 `mkinitramfs: failed to determine device for /` 错误并中断执行，dpkg 会因此停留在未配置完成的状态。解决办法是修改 `/etc/initramfs-tools/initramfs.conf`，将 `MODULES=dep` 改为 `MODULES=most`，然后执行 `sudo dpkg --configure -a` 完成剩余的配置。这一修改的唯一影响是官方内核的 initramfs 体积会略微增大。

重启：

```bash
sudo reboot
```

## 7 验证

重启完成后，先确认内核版本与页大小：

```bash
uname -r              # 应与第4节 kernelrelease 的输出一致
getconf PAGE_SIZE     # 预期为 4096
lsblk -d -o NAME,MODEL,SIZE,ZONED
```

HC620 应出现在列表中，ZONED 列显示 `host-managed`。随后针对具体设备做进一步确认。设备名以 `lsblk` 的实际输出为准，经 USB-SATA 桥接时不一定是 sda：

```bash
cat /sys/block/<设备名>/queue/zoned   # 预期 host-managed
sudo dmesg | grep -Ei 'zoned|zbc|host-managed'
```

![](https://img.gulugulublog.com/posts/raspberry-pi-5-kernel-cross-compile-zoned/20260724180729204.png)

最后确认 dm-zoned 与 zonefs 两个模块的来源：

```bash
modinfo -n dm-zoned zonefs
```

输出的两条路径都应位于当前 `uname -r` 对应的 `/lib/modules/<内核版本>/` 目录下，本文实测示例为 `/lib/modules/6.18.39-v8-4k-zoned+/`。验证完成后，分区与格式化操作与[前文](https://www.catwhiteangel.com/hc620-hm-smr-raspberry-pi-5/)一致，直接参照执行即可。

## 8 回滚

如需恢复官方内核，注释或删除 `config.txt` 中的 `os_prefix=zoned/` 一行并重启即可。官方内核、官方设备树和官方 `cmdline.txt` 全程未做改动，删除前缀后系统会自动回到原有启动文件，保留 `[all]` 行没有影响。无论编译配置有误还是新版本存在问题，回滚成本仅为一次重启，这是本方案在可维护性上最大的优势。

如果系统已经无法引导，可将 SD 卡插入其他机器直接修改 `config.txt`。boot 分区为 FAT 格式，在任意操作系统上均可读写。

## 9 跟版更新

需要先明确更新机制。用户态软件包仍会通过 apt 正常接收安全更新，apt 也会照常更新官方内核文件（`os_prefix` 目录之外的部分），但**正在引导的自编内核不会随之自动升级**。内核的漏洞修复与版本合并需要手动跟版、重新编译并安装。具体流程为重复上述步骤：

```bash
cd linux
git fetch --depth=1 origin rpi-6.18.y
git reset --hard FETCH_HEAD   # 重置到刚抓取的提交
git rev-parse --short HEAD

make ARCH=arm64 mrproper   # 清除旧 .config 和构建产物
# 完整重放第 3 节：重新生成新版 bcm2712_defconfig，
# 再应用 scripts/config 差异并执行 olddefconfig
# 之后按原流程编译、打包、传输、安装
```

必须**完整**重放上述步骤，包括 `bcm2712_defconfig` 这一步，不要沿用旧版 `.config`。官方 defconfig 在新版本中可能存在增删，直接沿用旧配置会偏离“官方默认加少量差异”的原则，配置差异会随版本推移不断累积。

模块目录以完整内核版本号（基础版本 + LOCALVERSION）命名，基础版本从 6.18.39 更新到 6.18.40 后，模块会安装到新目录而非覆盖旧目录。确认旧自编内核不再用于引导后，可手动删除对应的 `/lib/modules/` 目录。官方内核的模块目录必须始终保留，回滚操作依赖这些文件。重复构建同一基础版本则无需特殊处理，第六节的安装命令本身采用先删后装的方式，不会残留已从配置中移除的旧模块。

建议将第3至5节的命令整理为脚本并纳入 dotfiles 管理，跟版时执行一次即可完成打包。可定期检查 `rpi-6.18.y` 分支是否发布了新的补丁版本，遇到安全公告或重要修复时及时重新编译。

## 结语

到这里，从配置、编译、打包到安装、验证、回滚的完整流程已经完成。整套方案的核心只有两点：用 `scripts/config` 显式表达与官方 defconfig 的差异，用 `os_prefix` 把自编内核的启动文件整体隔离。前者保证跟版重编可以逐条复现，后者保证任何环节出问题都能用一次重启退回官方内核。

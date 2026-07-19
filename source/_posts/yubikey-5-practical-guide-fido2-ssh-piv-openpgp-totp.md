---
title: YubiKey 5 实践指南——用一把硬件密钥统管 FIDO2、SSH、PIV、OpenPGP 与 TOTP
date: 2026-06-22 17:45:00
categories: [Linux Security]
tags: [YubiKey, FIDO2, PIV, OpenPGP, SSH]
description: 围绕一把 YubiKey 5 NFC 把日常认证逐项迁移的实践记录：FIDO2/Passkey 登录、SSH 认证、PIV、OpenPGP 签名与加密、TOTP 验证码，以 Arch Linux 为主、单独标注 Windows 差异，含固件容量与购买建议。
---

# YubiKey 5 实践指南——用一把硬件密钥统管 FIDO2、SSH、PIV、OpenPGP 与 TOTP

买 YubiKey 之前我一直觉得硬件密钥（hardware security key）是种偏执的东西——密码管理器加上手机验证器，难道还不够安全吗。真正让我改主意的不是某次安全事件，而是一个朴素的认识：我所有的「第二因素」其实都长在同一台手机里，验证器 App、短信、Passkey 全在那块屏幕后面。手机一旦丢失或被攻破，这层防线是同时塌的。YubiKey 5 解决的就是这件事——它把私钥这种最敏感的材料锁在一块独立的、无法被软件读出的芯片里，让认证这一步必须有「物理在场」才能完成。

这篇文章是我围绕一把 YubiKey 5 NFC 把日常认证逐项迁移过去的完整记录，覆盖四种主要用途：用 FIDO2 登录网站、用它做 SSH 认证、用 OpenPGP 加密与签名、以及替代手机上的验证器 App 生成 TOTP 验证码。命令以 ArchLinux 为主，Windows 的差异之处会单独标出来。

## YubiKey简介

YubiKey 不是一个「U 盘」，把它理解成一张装了好几个独立小程序的智能卡（smart card）更准确。一把 YubiKey 5 里同时跑着几个互不干扰的应用，每个应用负责一类完全不同的协议：

- **FIDO2/WebAuthn**——现代无密码登录与 Passkey，也是 SSH 那条最省心路径的底层；
- **FIDO U2F**——FIDO2 的前身，作为纯第二因素仍被大量网站使用，可注册的服务数量无上限；
- **PIV（智能卡）**——用 X.509 证书那一套做认证，Windows 登录和某些企业场景会用到；
- **OpenPGP**——把 PGP 的签名、加密、认证三把子密钥装进卡里；
- **OATH-TOTP/HOTP**——也就是验证器 App 里那些每 30 秒跳一次的 6 位数；
- **Yubico OTP**——Yubico 自家那串一键吐出的长字符串，本文基本不涉及。

理解「这些是彼此独立的应用」很重要，因为它直接决定了存储上限和管理方式。每个应用各有各的容量，互不挤占。以固件（firmware）5.7 及以后的 YubiKey 5 为例，FIDO2 能存 100 个可发现凭据（discoverable credentials，也就是 Passkey），OATH 能存 64 个 TOTP 种子，PIV 有 24 个证书位，OTP 有 2 个槽——满打满算同时存放 190 个凭据。如果你的是 5.7 之前的固件，这两个数字分别是 25 和 32。固件无法升级（Yubico 出于缩小物理攻击面的考虑，刻意不允许刷写固件），所以买的时候就定了，这也是后面「为什么建议买两把」的伏笔之一。

查自己这把是什么固件、开了哪些应用，一条命令就够：

```bash
ykman info
```

输出大致长这样，重点看 `Firmware version` 和底部各应用的启用状态：

```
Device type: YubiKey 5 NFC
Serial number: 12345678
Firmware version: 5.7.1
Form factor: Keychain (USB-A)
Enabled USB interfaces: OTP, FIDO, CCID

Applications        USB     NFC
FIDO2               Enabled Enabled
FIDO U2F            Enabled Enabled
OpenPGP             Enabled Enabled
PIV                 Enabled Enabled
OATH                Enabled Enabled
OTP                 Enabled Enabled
```

## 准备工作：装工具、设 PIN、踩平权限的坑

### ArchLinux

核心工具是 `ykman`（YubiKey Manager CLI），它几乎是后面每一节都要用到的瑞士军刀。其余的包按用途分批装，我先把这一整篇会用到的依赖一次性列出来，你可以按需取舍：

```bash
# 必需：管理 YubiKey 的命令行工具
sudo pacman -S yubikey-manager

# 按需：FIDO2 本地登录 / pam 相关
sudo pacman -S libfido2 pam-u2f

# 按需：OpenPGP 智能卡，gnupg 会一并拉入 pinentry 与 scdaemon
sudo pacman -S gnupg pcsclite ccid

# 按需：PIV / 通过 PKCS#11 走 SSH（yubico-piv-tool 提供 /usr/lib/libykcs11.so）
sudo pacman -S opensc yubico-piv-tool
```

**装完 `pcsclite` 后，记得把 `pcscd` 起起来**——这一步漏掉，是后面所有 CCID 类操作（OATH、PIV、OpenPGP）翻车的头号原因：

```bash
sudo systemctl enable --now pcscd.socket
```

少了它，`ykman info` 顶部会蹦出 `WARNING: PC/SC not available. Smart card (CCID) protocols will not function.`，而 `ykman oath`、`ykman piv`、`gpg --card-status` 会读不到卡。`ykman info` 的设备基本信息倒还能显示，因为那走的是 USB 的 HID 接口、不经 PC/SC——别被这点信息误导以为一切正常。用 `pcscd.socket` 而非 `.service` 是 Arch 的惯例：按需自动拉起，不必常驻。

想要图形界面的话，`yubico-authenticator` 提供一个统一管理 OATH、Passkey、PIN 的 GUI，官方仓库一般能直接装，装不到就去 AUR 找：

```bash
sudo pacman -S yubico-authenticator
```

`pcscd` 一跑起来，紧接着就会撞上**第二个经典坑**：`gnupg` 自带的 `scdaemon` 默认优先用它**内置的 CCID 驱动**直接抓卡，而此时卡已被 `pcscd` 独占，于是 `gpg --card-status` 会报 `selecting card failed: No such device` 或 `Operation not supported by device`——卡是好的，是两个程序在抢同一张卡。解法是让 `scdaemon` 别单干、统一走 `pcscd`：在 `~/.gnupg/scdaemon.conf` 里加一行 `disable-ccid`，然后**重启 `scdaemon` 让配置生效**（这一步最容易漏，改完不重启等于没改）：

```bash
echo "disable-ccid" >> ~/.gnupg/scdaemon.conf
gpgconf --kill scdaemon          # 必须重启，scdaemon 不会自动重载配置
```

之所以推荐「`pcscd` 常驻 + `scdaemon` 走 `pcscd`」而不是反过来关掉 `pcscd`，是因为 `ykman` 的 OATH/PIV/OpenPGP 操作本就依赖 `pcscd`；让全机器统一一个卡入口，冲突源最少。如果 `gpgconf --kill scdaemon` 之后仍读不到，把整个 agent 一起重启再试：`gpgconf --kill all`。

另一个权限问题：以普通用户跑 `ykman` 时如果提示找不到设备，多半是 udev 规则缺失。较新的 systemd（249 以后）已经内置了给 FIDO 安全密钥打 `uaccess` 标记的规则，多数情况下插上就能用，不需要额外配置。万一确实不行，把 YubiKey 拔下重插、或 `sudo udevadm control --reload` 之后再试一次，仍不行再去补 Yubico 官方那份 udev 规则。

工具就绪后，第一件该做的事不是去注册任何账号，而是**给 FIDO2 设一个 PIN**。出厂的 YubiKey 没有 FIDO PIN。对于只要求“触摸确认”的 2FA 场景，拿到实体钥匙的人在已知账号密码的前提下可能完成第二因素；而对于真正 passwordless / Passkey 场景，是否必须输入 PIN 取决于服务端是否要求 User Verification。无论如何，给 FIDO2 设置 PIN 都是必要的。设了 PIN 之后，使用 FIDO2 凭据需要「PIN + 触摸」两个条件，丢失（尤其是被偷）时多一道屏障，也能挡住 evil maid 那类近身攻击：

```bash
ykman fido access change-pin
```

提示一下：这个所谓的 PIN 其实是字母数字混合的口令，不限于数字，可以也应该用一个像样的密码。但它是你每次用 FIDO2 时都要敲的东西，太长会折磨自己，自己权衡。

### Windows

Windows 上建议安装 Yubico Authenticator 作为图形界面工具；高级配置使用 YubiKey Manager CLI（ykman）。旧版 YubiKey Manager GUI 已停止支持，不建议作为主要工具。

## 用途一：FIDO2 / Passkey 登录网站

这是收益最高、上手最快的一项，也是我建议任何人拿到 YubiKey 后第一个迁移的场景。FIDO2 的价值不只是「多一个因素」，而是它从协议层面抗钓鱼（phishing-resistant）：浏览器在认证时会把当前域名一起参与签名，所以哪怕你被一个像素级仿冒的钓鱼站骗了，YubiKey 也会因为域名对不上而拒绝签名——这是验证器 App 的 6 位数做不到的，那串数字你照样会手贱输进假网站。

操作上没有命令行的事，全在浏览器里完成：登录目标网站，进安全设置，找「安全密钥（Security Key）」或「Passkey」入口，按提示插入 YubiKey、输入刚才设的 FIDO PIN、触摸金属面板完成注册。GitHub、Google、Microsoft、Cloudflare 这些主流服务都支持，想确认某个具体服务支不支持，查 Yubico 的「Works with YubiKey」目录最省事。

![](https://img.gulugulublog.com/posts/yubikey-5-practical-guide-fido2-ssh-piv-openpgp-totp/20260622211000597.png)

注册完想看看卡里存了哪些可发现凭据（也就是占用那 100/25 个 Passkey 槽的那些）：

```bash
ykman fido credentials list
```

![](https://img.gulugulublog.com/posts/yubikey-5-practical-guide-fido2-ssh-piv-openpgp-totp/20260622211136730.png)

注意区分两个概念。U2F 那种纯第二因素的注册是「不可发现凭据」，不占卡内存储，数量无上限；而 Passkey（可发现凭据）才占那 100 或 25 个槽。日常用 YubiKey 当第二因素几乎不可能用满，但如果你真的全面拥抱无密码、到处存 Passkey，就要把这个上限放心上了。

触摸金属盘时如果它开始闪烁，**这是正常的「等待你确认在场」的信号，不是设备出问题**，碰一下即可。

## 用途二：SSH 认证

SSH 这块路子有好几条，**对绝大多数个人用户，走 FIDO2 的 `ed25519-sk` 密钥是最简单且足够安全的选择**，比传统的 PIV/PKCS#11 配置省心得多，也不必动用 OpenPGP 那套重型方案。所以这一节我以 FIDO2 为主线详写，再单独用一节交代 PIV/PKCS#11 这条路——它配置更繁、但在某些场景下不可替代，值得知道它存在以及何时该用。

前提条件先对一下：OpenSSH 8.2 起支持 FIDO 密钥类型，8.3 起支持 resident key 的下载；`ed25519-sk` 需要 YubiKey 固件 5.2.3 及以上。YubiKey 5 全系都满足，ArchLinux 上的 OpenSSH 也早就够新，可以放心。

### resident 还是 non-resident，先想清楚

`-sk`（security key）类型的密钥有两种存放方式，差别不在安全等级高低，而在「便携性」与「攻击面」的取舍：

- **non-resident（不可发现）**：默认方式。生成时会在 `~/.ssh/` 下落一个私钥句柄文件，这个文件**不含真正的私钥**，只是一个指向 YubiKey 内部主密钥的引用。用的时候需要「句柄文件 + YubiKey」两者俱全。好处是它不占用卡内那有限的凭据槽，而且就算 YubiKey 被偷，攻击者光有卡、没有那个句柄文件也用不了。
- **resident（可发现）**：私钥句柄存在 YubiKey 里，可以在任意一台新机器上用 `ssh-keygen -K` 把它拉回来，不依赖原机器的文件。代价是它会吃掉卡内凭据槽，而且一旦别人同时拿到你的 YubiKey 和 PIN，光凭卡就能用。

我的取法是：**日常固定那几台机器用 non-resident**，省槽又多一层文件因素；只有在「想做到换任何机器都能即时恢复」的少数密钥上才用 resident。下面两种都给出来。

### 生成 non-resident 密钥（推荐）

```bash
ssh-keygen -t ed25519-sk -O verify-required
```

`-O verify-required` 要求每次使用都验证 FIDO PIN，配合默认就有的「触摸」，相当于把「你知道的」和「你拥有的」两个因素都压在这一步上。既然有了 PIN，就不必再给私钥句柄额外设 passphrase 了，那是冗余的。生成时它会要你输 FIDO PIN、再触摸一下确认。完成后 `~/.ssh/` 里会有 `id_ed25519_sk` 和 `id_ed25519_sk.pub`，**`.pub` 才是真正要分发出去的公钥**。

### 生成 resident 密钥（需要跨机即时恢复时）

```bash
ssh-keygen -t ed25519-sk -O resident -O verify-required -O application=ssh:archbox
```

`-O application=ssh:archbox` 给这把 resident 密钥起个可辨识的标签，否则多把 resident 密钥都叫默认名字时会互相覆盖，生成时报 `A resident key scoped to 'ssh:' with user id 'null' already exists`。换了新机器后，把 resident 密钥句柄拉回本地：

```bash
cd ~/.ssh
ssh-keygen -K        # 输 PIN、触摸，卡里的 resident 句柄会被下载成文件
```

它下载下来的文件名带 `_rk` 后缀（resident key），我习惯重命名去掉它，纯属个人整洁癖好，不影响功能。

### 部署与使用

把公钥追加到目标服务器的 `~/.ssh/authorized_keys`，或者用 `ssh-copy-id`：

```bash
ssh-copy-id -i ~/.ssh/id_ed25519_sk.pub user@server
```

之后正常 `ssh user@server`，连接时会提示触摸 YubiKey（设了 `verify-required` 还会先要 PIN）。GitHub 也支持 `-sk` 类型公钥，直接贴到 Settings → SSH keys 即可。如果你用 `ssh-agent`，可以用下面这条把 YubiKey 里的 resident 密钥直接加载进 agent，全程不落地到文件系统：

```bash
ssh-add -K
```

排障两则。其一，如果连接时报 `sign_and_send_pubkey: signing failed ... agent refused operation`，多半是某个旧的 `ssh-agent` 不支持带 PIN 的 `-sk` 密钥在捣乱，临时解法是连接时加 `-o IdentitiesOnly=yes` 绕开 agent。其二，服务器端如果想强制要求 PIN 验证而非仅触摸，可在 `sshd_config` 里设置接受 `sk-ssh-ed25519@openssh.com` 类型并要求 `verify-required`，但大多数发行版默认配置已经够用，没遇到问题就别去动它。

还有一个常让人困惑、其实是正常行为的点：**触摸只在服务器认可这把公钥之后才会触发**。SSH 公钥认证分两步——先把公钥「报」给服务器问认不认，认了才真正签名（也就是要你触摸的那一步）。所以如果你拿一把还没加进服务器的密钥去连，会在签名之前就被回绝 `Permission denied (publickey)`，**全程不提示触摸**——这不是卡坏了，是根本没走到签名。想脱离服务器单独验证这把密钥能签、能触发触摸，可以就地签个文件试：`ssh-keygen -Y sign -f ~/.ssh/id_ed25519_sk -n test 某个文件`，它会要 PIN 并提示触摸。

### Windows 上的差异

Windows 自带的 OpenSSH 对 FIDO2 的支持随版本起伏，老版本干脆不支持，新版有时也有怪毛病。稳妥路径是用 Git for Windows 自带的那个 OpenSSH（确保版本 ≥ 8.2），在 Git Bash 里跑上面那些命令。还有两个 Windows 特有的点：设 FIDO PIN 时 YubiKey Manager 要以管理员身份运行；生成 resident 密钥时 Git Bash 也建议用管理员身份打开，否则可能报 `invalid format`。另外 Windows 下 `ssh-keygen` 无法事先检查 resident 密钥是否已存在，所以它每次都会问你是否覆盖——这时去 Yubico Authenticator 里看一眼现有 Passkey 列表，确认无冲突再继续即可。

### 顺带：用 SSH 密钥给 Git 提交签名

有了这把 `-sk` 密钥，给 Git 提交签名不必再搬出 GPG，直接复用它即可，配置三行：

```bash
git config --global gpg.format ssh
git config --global user.signingkey ~/.ssh/id_ed25519_sk.pub
git config --global commit.gpgsign true
```

之后每次 `git commit` 都会要求触摸 YubiKey 完成签名。GitHub 上把这把公钥额外注册为 Signing Key（注意和 Authentication Key 是分开的两栏），提交旁边就会显示 Verified 绿标。

### 另一条路：PIV / PKCS#11

前面那条 FIDO2 路径对个人足够了，那为什么还要了解 PIV。三种情况下它不可替代：你的 SSH 客户端或对端环境只认智能卡 / PKCS#11、不支持 `-sk` 密钥；你想用 YubiKey 当一个 SSH 证书颁发机构（CA），用卡里的私钥去签发其他人的用户密钥或主机密钥；或者你本来就在一个「一切走智能卡」的企业体系里，PIV 能和 Windows 智能卡登录那套复用。如果这三条都不沾边，看一眼知道有这回事就行，不必真去配。

PIV 的思路和 FIDO2 完全不同：它把一对标准的 RSA/EC 密钥存在卡里的某个 PIV 槽位（slot）里，再通过一个 PKCS#11 模块把这把硬件密钥「桥接」给 OpenSSH。SSH 用的是「认证」用途，对应槽位 `9a`。

先把 PIV 自己的几个默认口令改掉——它和 OpenPGP、FIDO2 的 PIN 都是各自独立的，**出厂默认值是公开的，不改等于没设**。PIV 有三个凭据：用户 PIN（默认 `123456`）、PUK（解锁码，默认 `12345678`）、管理密钥（management key，有公开的默认值）：

```bash
ykman piv access change-pin                       # 改用户 PIN
ykman piv access change-puk                       # 改 PUK
ykman piv access change-management-key --generate --protect   # 随机生成管理密钥并用 PIN 保护
```

`--generate --protect` 这一步值得说一句：它让卡自己随机生成一个管理密钥并用 PIN 守护，这样你日后做管理操作只需记住 PIN，不必再额外保管那串又长又容易抄错的管理密钥，对个人使用是更省心的默认。

接着在槽位 `9a` 生成密钥。算法上我推荐 `ECCP256`——它快、公钥短，且各家 PKCS#11 模块支持都成熟；`ED25519` 虽然 5.7 固件的 PIV 已支持，但 ykcs11 对它的 SSH 支持一度有坑，求稳就先用 ECC。生成时顺手把使用策略也定下来：

```bash
ykman piv keys generate --algorithm ECCP256 \
  --pin-policy once --touch-policy always \
  9a public.pem
```

`--pin-policy once` 表示一个会话里输一次 PIN 即可，`--touch-policy always` 要求每次签名都触摸——和前面 FIDO2 的思路一致，把「你知道的」和「你拥有的」都焊进每次操作。这条命令会把公钥写到 `public.pem`。

**下面是这一整节最容易栽的坑，务必照做**：你必须再往同一个槽位塞一张证书（哪怕是自签的），否则 PKCS#11 模块根本读不到这把公钥，后面 SSH 一步会神秘地拿不到任何身份。这张 X.509 证书唯一的作用就是充当 PKCS#11 提取公钥的「容器」，内容是什么不重要：

```bash
ykman piv certificates generate --subject "CN=SSH key" 9a public.pem
```

到这里私钥已经躺在卡里了，但 `public.pem` 是 PEM 格式，SSH 不直接吃。用 PKCS#11 模块把它转成 SSH 公钥格式。ArchLinux 上有两个模块可选，装 `yubico-piv-tool` 得到的 ykcs11 是 Yubico 自家的、对 YubiKey 适配最好，路径 `/usr/lib/libykcs11.so`；装 `opensc` 得到的是通用的 `/usr/lib/opensc-pkcs11.so`。两者都行，我用前者：

```bash
ssh-keygen -D /usr/lib/libykcs11.so -e
```

它通常会吐出不止一把公钥（认证用的那把、外加一个 attestation 公钥），**取第一把**（标着 PIV Authentication 的那个），贴到服务器的 `authorized_keys` 或 GitHub 即可。

日常使用有三种接法，按口味挑一种。最省事的是写进 `~/.ssh/config`，让 SSH 每次自动加载这个模块：

```
PKCS11Provider /usr/lib/libykcs11.so
```

之后正常 `ssh user@server`，会提示输 PIV PIN、再触摸。或者临时指定，不写进配置：

```bash
ssh -I /usr/lib/libykcs11.so user@server
```

又或者把它挂进 `ssh-agent`，用完再卸下（`-s` 加载，`-e` 移除）：

```bash
ssh-add -s /usr/lib/libykcs11.so   # 加载，会要 PIN
ssh-add -e /usr/lib/libykcs11.so   # 移除
```

排障四则。其一，`ssh-keygen -D` 报 `is not a PKCS11 library` 或 `No such file or directory`，是 `/usr/lib/libykcs11.so` 不存在——它由 `yubico-piv-tool` 包提供，没装就没有这个文件，`sudo pacman -S yubico-piv-tool` 即可（装完可用 `pacman -Ql yubico-piv-tool | grep libykcs11` 核对路径）。其二，SSH 不报错但就是不认密钥、`ssh -vvv` 里看不到来自卡的身份——十有八九是忘了上面那步生成证书，回去补 `ykman piv certificates generate`。其三，想确认卡里到底有什么，`ykman piv info` 会列出各槽位的密钥和证书状态，是排查的第一站。其四，PIV PIN 连续输错会锁定（默认三次），这时要用 PUK 解锁；PUK 也输错耗尽，整个 PIV 应用就只能 `ykman piv reset` 全清重来了——所以改完 PIN 记得找个可靠地方记下来。

一个固件相关的差异：`ykman piv keys delete`（单独删某个槽里的私钥、保留其它）是固件 **5.7.0 才加入**的操作，5.4.x 等较老固件会报 `requires YubiKey 5.7.0 or later`。老固件上想腾空一个槽，只能删证书（`ykman piv certificates delete <slot>`，删后该槽不再被 PKCS#11 暴露、`ykman piv info` 也不再列出），或往该槽写入新密钥把旧的覆盖掉。

Windows 原生支持智能卡体系，但“能被 Windows 识别”不等于“能直接用于系统登录”。除了装好 YubiKey Minidriver，域登录通常还需要 AD CS / 受信任 CA、正确的 UPN/SAN、EKU、证书映射和域控制器证书配置；普通自签 PIV 证书主要适合 SSH / TLS 客户端认证等个人场景。如果给 SSH 用则和 Linux 类似，指定 `libykcs11.dll` 作为 PKCS#11 模块即可。

最后掂量一下：对照前面 FIDO2 那节，PIV 这套明显步骤更多、坑更多。除非你确实落在开头说的那三种情况里，否则我的建议仍是用 `ed25519-sk`。把 PIV 写在这里，是为了让你在「FIDO2 不被支持」或「想搭 SSH CA」那天，知道还有这条路、也知道那张「没用却必需」的证书坑在哪。

## 用途三：OpenPGP 加密与签名

这一节明显比前面重，配置链路长、概念多，但换来的是把 PGP 私钥彻底锁进硬件——签名和解密都必须卡在身边、触摸确认才能完成，私钥永远不出卡。如果你本来就没在用 PGP，这节可以先跳过，等真有加密邮件或软件签名的需求了再回来。

### 一个关于备份的关键决策

YubiKey 的 OpenPGP 应用能装三把子密钥：签名（S）、加密（E）、认证（A）。生成这些密钥有两条路，**这个选择关乎你日后能不能恢复，务必想清楚再动手**：

- **直接在卡上生成**：私钥从诞生起就没离开过硬件，安全性最高。但代价是无法备份——卡坏了、丢了，用这把加密子密钥加密过的所有历史数据就**永久解不开了**。
- **离线生成后导入卡中**：先在一台离线的、可信的机器上生成密钥，妥善备份私钥（比如存进加密的离线介质），再把子密钥搬进卡里。卡只是私钥的一个「使用终端」，坏了换张卡、从备份恢复即可。

对签名和认证密钥，丢了大不了重新生成、重新分发公钥，影响有限；但**加密密钥强烈建议走离线生成 + 备份这条路**，否则你是在拿历史数据的可恢复性做赌注。下面这一小节就把完整流程逐步走一遍。

### 离线生成密钥并迁移到卡（推荐流程）

这套流程的核心思想是：**主密钥（master key）永远不上卡、不联网，只在需要签发新子密钥或撤销时才离线取出**；真正天天用的签名、加密、认证三把子密钥才放进 YubiKey。这样即便卡丢了、甚至日常机器全毁了，只要离线备份还在，你就能换张卡从头恢复。这也是 drduh 的 YubiKey-Guide 推崇的模型，下面是我精简后的可操作版本。**建议先完成OpenPGP user PIN / Admin PIN修改再继续**

理想情况下这一整套该在一台断网的机器、甚至 Tails 这类一次性系统里做。退一步，至少用一个临时、隔离的 keyring 来操作，避免污染你日常的 `~/.gnupg`：

```bash
export GNUPGHOME=$(mktemp -d)        # 开一个临时、隔离的 GnuPG 目录
```

**第一步，生成仅用于认证（Certify-only）的主密钥。** 主密钥只保留 certify 能力——它的唯一职责就是「为子密钥背书、以及在紧急时撤销」，不参与日常签名加密。算法上 YubiKey 5（固件 5.2.3+）的 OpenPGP 已支持 Curve 25519，我用 `ed25519`，更快、公钥更短；若你追求最大兼容性，换成 `rsa4096` 也行：

```bash
gpg --quick-generate-key "Your Name <you@example.com>" ed25519 cert never
```

记下输出里的指纹（fingerprint），后面要反复用到。为方便，把它存进变量：

```bash
export KEYFP=<上一步输出的40位指纹>
```

**第二步，加三把子密钥：签名、加密、认证。** 给它们设个有限有效期（比如一年）不是因为怕被破解，而是一种「定期续期」的健康习惯，主密钥还在你手上，到期前 `gpg --quick-set-expire` 续一下即可：

```bash
gpg --quick-add-key $KEYFP ed25519 sign 1y
gpg --quick-add-key $KEYFP cv25519 encrypt 1y
gpg --quick-add-key $KEYFP ed25519 auth 1y
```

**第三步，生成撤销证书（revocation certificate）。** 现代 GnuPG 在建主密钥时已自动在 `$GNUPGHOME/openpgp-revocs.d/` 下放了一份，但我习惯再手动导一份单独保管——万一私钥被盗或丢失，这张证书能让你向密钥服务器宣告「此密钥作废」：

```bash
gpg --output revoke.asc --gen-revoke $KEYFP
```

**第四步——也是最关键、最容易出顺序错的一步：先备份，再上卡。** 务必在 `keytocard` 之前把私钥完整导出备份好。原因下面紧接着讲：

```bash
gpg --armor --export-secret-keys $KEYFP > master-and-subs.asc   # 主密钥+子密钥，最完整的底
gpg --armor --export-secret-subkeys $KEYFP > subs-only.asc       # 仅子密钥，用于灌第二张卡
gpg --armor --export $KEYFP > public.asc                          # 公钥，可公开分发
```

把 `master-and-subs.asc`、`revoke.asc` 连同那个 `openpgp-revocs.d/` 目录一起，存进加密的离线介质（我的做法是写进一块 LUKS 加密的 U 盘，再额外打印一份纸质副本锁起来）。**这一步偷不得懒**：一旦下一步把子密钥搬进卡，本地的私钥就变成了只是指向卡的「存根（stub）」，不再是真私钥了。

**第五步，把三把子密钥搬进 YubiKey。** 注意 `keytocard` 是**移动而非复制**——执行并 `save` 之后，本地这把子密钥私钥就被卡内引用替代了。这正是上一步必须先备份的原因：你手上若只有卡、没有备份，就再也灌不出第二张卡：

```bash
gpg --edit-key $KEYFP
# 进入交互界面后：
# gpg> key 1        选中第 1 把子密钥（签名）
# gpg> keytocard    按提示选「Signature」槽
# gpg> key 1        取消选中
# gpg> key 2        选中第 2 把（加密）
# gpg> keytocard    选「Encryption」槽
# gpg> key 2
# gpg> key 3        选中第 3 把（认证）
# gpg> keytocard    选「Authentication」槽
# gpg> key 3
# gpg> save
```

`gpg --card-status` 这时应该能看到三个槽位都已填上对应子密钥的指纹。

**第六步，在日常机器上「认领」这张卡。** 在你平时用的机器上，先导入公钥，再让 GnuPG 扫一遍卡，它会自动建立指向卡的私钥存根：

```bash
gpg --import public.asc
gpg --card-status            # 扫到卡后自动生成 stub
```

之后这台机器就能用卡做签名、解密、认证了，而私钥始终在卡里。

**关于第二张卡**（前面反复强调要买两把，这里兑现）：你**不能**把已经 `keytocard` 进卡一的子密钥再搬一次——那份在本地已是存根。正确做法是另开一个干净的临时 `GNUPGHOME`，从备份重新导入，再对第二张卡重复第五步：

```bash
export GNUPGHOME=$(mktemp -d)
gpg --import master-and-subs.asc   # 从备份恢复出真私钥
gpg --edit-key $KEYFP              # 再走一遍 keytocard，灌进第二张卡
```

**想清楚「全损场景」会发生什么**，这是判断备份做得够不够的试金石：如果只剩卡、丢了所有备份，你仍能用卡签名解密，但**无法**续期、无法新增子密钥、无法签发第二张卡，撤销也只能靠那张单独的撤销证书——本质上你被锁死在当前这张卡的寿命里。反过来，只要 `master-and-subs.asc` 和撤销证书还在，卡丢了不过是再灌一张的事。所以这两份备份的价值，远高于卡本身。

最后清理临时环境（仅删临时 keyring，不影响你的日常 `~/.gnupg`）：

```bash
gpg --homedir "$GNUPGHOME" -K   # 确认该导出的都导出了
rm -rf "$GNUPGHOME"
unset GNUPGHOME KEYFP
```

### 设置卡、改 PIN、加触摸策略

把卡接上，先看状态：

```bash
gpg --card-status
```

OpenPGP 应用有两个独立的 PIN，出厂默认值是公开的，**第一件事就是改掉它们**：用户 PIN 默认 `123456`，管理员 PIN（Admin PIN）默认 `12345678`。进卡管理界面修改：

```bash
gpg --card-edit
# 进入后依次：
# gpg/card> admin
# gpg/card> passwd
# 然后按菜单分别改 user PIN 和 admin PIN
```

强烈建议再给三把子密钥都打开**触摸策略**——默认情况下卡只要插着，签名/解密就会自动进行，攻击者控制了你的机器就能静默地拿卡干活。开了触摸之后，每次签名或解密都必须有人物理碰一下金属盘，恶意软件再怎么自动化也没法替你触摸：

```bash
ykman openpgp keys set-touch sig on   # 签名
ykman openpgp keys set-touch enc on   # 解密
ykman openpgp keys set-touch aut on   # 认证
```

设置触摸策略时会要求输入 Admin PIN 确认。`on` 是「需要触摸」，还有 `fixed`（设了就不能再关，更偏执）等选项，按需选 `on` 即可。

### 把 OpenPGP 认证子密钥也用作 SSH

如果你已经在 PGP 这条路上，那把认证子密钥（Authentication subkey）可以顺手当 SSH 密钥用，让 `gpg-agent` 兼任 `ssh-agent`。在 `~/.gnupg/gpg-agent.conf` 里加一行：

```
enable-ssh-support
```

然后让 SSH 客户端去找 `gpg-agent` 的套接字：

```bash
export SSH_AUTH_SOCK=$(gpgconf --list-dirs agent-ssh-socket)
```

这行通常写进 `~/.bashrc` 或 `~/.zshrc`。导出可贴到服务器的 SSH 公钥：

```bash
gpg --export-ssh-key <你的KEYID>
```

说句实话：在已经有了 FIDO2 `-sk` 方案的今天，除非你本来就重度依赖 PGP 生态，否则没必要专门为了 SSH 去搭这套 `gpg-agent`。它更适合「我 PGP 都配好了，SSH 顺便复用」的场景，而不是反过来为 SSH 引入 PGP。

## 用途四：TOTP，替掉手机上的验证器 App

OATH-TOTP 就是各类「验证器 App」里那串每 30 秒刷新的 6 位数。把它们搬到 YubiKey 上的意义在于：种子（secret）存进硬件后无法被读出或克隆，手机丢了、被装了恶意软件也波及不到这些码。代价是每次取码要插卡——便利性换安全性，自己判断哪些账号值得。

需要注意，OATH-TOTP 仍然是可被钓鱼中继的 6 位验证码；把它放进 YubiKey 主要提升的是 seed 的本地保护和设备隔离，不等同于 FIDO2/WebAuthn 那种协议级抗钓鱼。

命令行加一个账号，最常见是从网站给的密钥字符串添加：

```bash
ykman oath accounts add GitHub JBSWY3DPEHPK3PXP
```

更省事的做法是直接喂给它整条 `otpauth://` URI（很多网站会在二维码旁给出这串文本）：

```bash
ykman oath accounts uri 'otpauth://totp/GitHub:me?secret=JBSWY3DPEHPK3PXP&issuer=GitHub'
```

取码：

```bash
ykman oath accounts code GitHub
```

列出全部账号：

```bash
ykman oath accounts list
```

如果只有二维码、拿不到文本密钥，用图形版的 Yubico Authenticator 最方便——它能直接扫屏幕上的二维码完成添加，省去手抄。想给某个高价值账号再加一道关，添加时带上 `--touch`，取码时就必须触摸一次：

```bash
ykman oath accounts add --touch GitHub JBSWY3DPEHPK3PXP
```

还可以给整个 OATH 应用设一个访问口令，这样别人光插卡也读不到你的验证码：

```bash
ykman oath access change
```

容量上限前面提过：5.7 固件 64 个，更早的 32 个。日常账号一般够用，真不够再考虑分配到第二把卡上。

## 备份与遗失：这一节比前面所有节都重要

前面讲了那么多怎么把鸡蛋装进 YubiKey 这个篮子，现在必须正视一个问题：**如果这个篮子掉了呢。** YubiKey 没有云同步、私钥读不出来、固件不能克隆——这些正是它安全的根基，但也意味着它丢了就是真丢了，没有「找回」一说。所以负责任的做法只有一个：

**买两把，从一开始就把两把一起注册。** 这不是可选项，是这套方案能不能落地的前提。具体到各应用：

- **FIDO2 / Passkey**：在每个支持的服务里，把备用 YubiKey 当成又一把新密钥，按和主卡完全相同的流程再注册一遍即可。多数服务允许注册多个安全密钥。
- **TOTP**：因为种子无法从卡里导出，没法「复制」到第二把卡。正确做法是在最初添加账号时，把那串密钥/二维码同时添加进两把卡（所以别添加完就把密钥扔了，先确认两把都进了再说）。同时把各服务的恢复码（recovery codes）打印或离线存好。
- **OpenPGP**：如果你按前面建议走的是「离线生成 + 备份」，那么从备份把同一套子密钥导入第二张卡就行；如果当初图省事在卡上直接生成，那第二把卡只能是另一套独立密钥，恢复体验会差很多——这也是我反复强调离线生成的原因。
- **SSH**：non-resident 密钥依赖本地句柄文件，丢卡后这把就废了，所以同样建议给第二把卡生成对应密钥并一起部署到服务器；resident 密钥则可以在任意机器上用第二把卡重新拉取（前提是你也在第二把卡上存了对应的 resident 凭据）。

把备用 YubiKey 和主卡分开存放——一把随身，一把锁在家里抽屉或保险箱。两把的型号不必相同，主卡是 5C NFC、备用是 5 NFC 完全没问题，按你接触到的设备接口来配反而更灵活。

## 结语

迁移完之后回头看，YubiKey 真正改变的不是某一次登录有多安全，而是它逼着我把「我的身份到底依赖什么」这件事想清楚了一遍——哪些账号值得上硬件、哪些密钥需要能恢复、丢了之后我还剩什么。这个梳理的过程，价值不亚于那块芯片本身。

不用追求一天之内把所有东西都搬过去。我自己也是先把 GitHub 和 Google 的登录换成 FIDO2，用顺手了再慢慢迁 SSH、最后才碰 PGP。从收益最高、最省心的 FIDO2 开始，让这把小铁片先在日常里证明它的价值，剩下的自然会水到渠成。

**最后祝各位的密码永不泄露**
---
title: 云服务器到手第一件事——Ubuntu 24.04 安全加固实操
date: 2026-07-26 14:13:00
categories:
  - Linux Security
tags:
  - Ubuntu
  - SSH
  - UFW
  - fail2ban
---

{% note info %}
作者声明：本文所有命令均在一台全新的 Ubuntu 24.04 云服务器上实际验证通过。软件版本迭代较快，若实际情况与本文描述存在差异，请以官方文档为准。
{% endnote %}

# 云服务器到手第一件事——Ubuntu 24.04 安全加固实操

拿到一台新的云服务器，在部署任何业务之前，需要先完成基础的安全加固工作。本文记录了这台服务器从初始状态到具备基本防护能力的完整操作过程，适用于所有需要长期在公网运行服务的 Ubuntu 24.04 主机。

<!-- more -->

## 0 为什么拿到服务器的第一件事是加固

一台刚开通的云服务器，公网 IP 分配后的几分钟内就会开始收到扫描流量。这并非针对性攻击，互联网上有大量自动化脚本在持续扫描全网段，发现 22 端口开放就会尝试用弱密码字典爆破 root。开一台新机器，观察一天后查看日志：

```bash
lastb | wc -l    # 统计失败登录次数
```

![](https://img.gulugulublog.com/posts/ubuntu-2404-server-hardening/20260726184020485.png)

通常能看到成百上千条失败记录。这就是加固需要应对的现实威胁，即无差别的自动化爆破，而不是有针对性的入侵。相应地，本文的加固思路也比较直接，分四层递进：

- **系统更新**：先修复已知漏洞，这是所有后续措施的基础。
- **SSH 加固**：爆破成立的前提是密码有可能被猜中。改为仅密钥登录后，基于服务器密码的在线字典爆破就失去了入口。
- **防火墙**：默认拒绝所有入站流量，只放行明确需要的端口，缩小暴露面。
- **fail2ban + 自动安全更新**：前者封禁反复试探的来源 IP，后者自动安装安全更新，降低漏打补丁的风险。需要重启才能生效的更新仍由管理员安排。

完成这四层之后，可以显著降低自动化扫描、口令爆破和意外端口暴露带来的风险。需要明确的是，这些措施针对的是自动化威胁。如果服务器上存在值得定向攻击的资产，则需要更完整的安全方案。对于个人自用、运行网站或游戏服务端等应用的机器来说，这个防护等级是合理的，且日常维护成本很低。

**本文环境**：

- **系统**：Ubuntu Server 24.04 LTS（云厂商官方镜像）
- **登录方式**：初始为 root 密码登录（不同厂商的初始交付方式不同，有的默认提供 ubuntu 用户和密钥，流程需要相应微调）
- **客户端**：任意支持 OpenSSH 的终端

另外需要注意，主流云厂商（阿里云、腾讯云、AWS 等）在 VPC 层面还提供一道**安全组（Security Group）**，它与本文配置的 ufw 是两道相互独立的防护，流量需要同时通过两者才能到达服务。建议两道都配置。安全组作用在网络入口，ufw 跟随系统本身，将来更换厂商或迁移镜像时，系统内的防火墙规则不会丢失。本文以 ufw 为主线，安全组的业务端口与 ufw 保持一致即可。安全组还有一个 ufw 示例中未体现的优势，即可以直接限制来源地址。如果有稳定的公网出口 IP，SSH 端口最好只对自己的 IP/CIDR 开放（如 203.0.113.10/32），而不是向 0.0.0.0/0 和 ::/0 全部开放。当出口地址经常变化、无法固定时，才向公网开放该端口，并依赖密钥认证、ufw 与 fail2ban 这几层防护。

## 1 系统更新

用初始凭据以 root 登录服务器。如果厂商交付的是普通用户，以下命令前需要加 sudo。

**1. 更新软件包索引**

```bash
apt update
```

**2. 安装当前可用的软件包升级**

```bash
apt upgrade
```

新开通的服务器，镜像内置的补丁通常落后当前版本数周到数月，第一次 upgrade 的更新量会比较大。这里是"当前可用"是因为有两类更新不会被立即安装。一类是因依赖变动被保留（held back）的包，`apt upgrade` 不会强行处理。另一类是 Ubuntu 分阶段更新（phased updates）机制下按比例灰度推送的包，当前机器可能延迟几天才会收到。这两种情况都属正常，不需要强行安装，也不建议在新机器上直接使用可能移除软件包的 `full-upgrade`。升级过程中如果弹出交互界面询问"哪些服务需要重启"，直接回车接受默认值即可。如果提示配置文件冲突，先按 D 查看差异。确认没有云厂商或个人定制时，可以采用维护者版本。拿不准时优先保留当前版本（N），升级完成后再手工合并。需要注意的是，即使是刚开通的机器，云镜像和 cloud-init 也可能已经修改过网络或 SSH 相关配置，不要仅因为"服务器是新的"就默认覆盖。

![](https://img.gulugulublog.com/posts/ubuntu-2404-server-hardening/20260726185846581.png)

**3. 如有内核更新，重启一次**

```bash
cat /var/run/reboot-required
reboot    # 上一条显示*** System restart required ***时执行
```

Ubuntu 通过 `/var/run/reboot-required` 文件标记存在需要重启才能生效的更新，典型情况是内核升级。新机器尚未部署业务，此时重启成本最低，建议在进入后续配置之前完成。等服务上线后再重启，就需要专门安排维护窗口了。

## 2 创建日常用户，告别 root 直连

root 是暴力破解脚本的首要目标，因为这个用户名必然存在，攻击者只需要猜密码。本节创建一个专用的日常管理用户，平时用它登录，需要提权时使用 sudo，root 的 SSH 登录则在后面彻底关闭。需要说明的是，真正起防护作用的是下一节的 `PasswordAuthentication no`、`PermitRootLogin no` 和 `AllowUsers` 白名单。关闭密码登录之后，用户名是否难以猜测已经无关紧要，因此取名以清晰、便于管理为主。

**1. 创建用户**

```bash
adduser deploy
```

Ubuntu 上推荐使用 `adduser` 而不是底层的 `useradd`。`adduser` 是 Debian 系的交互式封装，会自动创建家目录、复制 skel 模板并调用 passwd 设置密码，一条命令即可完成全部工作。`useradd` 不带参数时连家目录都不会创建。用户名请替换为你自己的。

这里设置的是本地密码，之后 sudo 提权时需要用到。SSH 登录不会用到它，因为下一节会关闭密码认证。因此设置一个强密码并存入密码管理器即可，不必追求好记。

**2. 加入 sudo 组**

```bash
usermod -aG sudo deploy
```

`-a` 表示 append（追加），`-G` 指定附加组。**`-a` 不能省略**。单独的 `-G` 含义是"将附加组列表设置为"，会把用户从其他所有附加组中移除。在新机器上这没有实际差别，但这个习惯值得从一开始就养成。Ubuntu 的 sudoers 默认放行 sudo 组（`%sudo ALL=(ALL:ALL) ALL`），入组即获得完整的 sudo 权限，无需再修改 sudoers 文件。

**3. 验证**

保持 root 会话不关，**另开一个终端**用新用户登录并验证提权：

```bash
ssh deploy@<服务器IP>
sudo whoami    # 输出 root 即成功
```

"另开终端验证、保留旧会话兜底"的做法贯穿本文。SSH 加固的每一步都可能把自己锁在门外，唯一可靠的保险是始终保留一个已登录的会话。

这里顺带约定后文的权限前提。涉及修改 /etc、安装软件、管理 systemd 服务和配置防火墙的服务器端命令，默认在保留的 root 会话中执行。如果你已经切换到 deploy 会话操作，请自行在这些命令前加 sudo。需要在客户端本地执行的命令会另行注明。

## 3 SSH 加固

本章是全文的核心。目标状态是：仅允许密钥登录、禁止 root 登录、限制认证重试次数。操作顺序不能乱。

### 3.1 部署密钥

**1. 在客户端（你自己的电脑）生成密钥对**

```bash
ssh-keygen -t ed25519 -C "deploy@my-server"
```

`-t ed25519` 指定椭圆曲线算法。它的密钥短（公钥约 80 个字符）、验证速度快，也没有 RSA 在密钥长度上的历史包袱，是当前 OpenSSH 推荐的算法。`-C` 只是注释，用于日后在 authorized_keys 里分辨这把密钥属于谁、用于什么，建议写成"用户@用途"的格式。提示输入 passphrase 时建议设置，它保护的是私钥文件本身，即使电脑丢失，没有 passphrase 也无法直接使用私钥。配合 ssh-agent 使用，日常并不需要反复输入。

如果提示 `id_ed25519 already exists. Overwrite (y/n)?`，说明这台电脑上已经存在一把同名密钥。此时**不要确认覆盖**，该操作会不可逆地销毁旧私钥，所有仍依赖它认证的服务器都会无法登录。接下来有两种选择：

- **复用现有密钥**：跳过生成步骤，直接部署现有公钥。个人场景下用一把带 passphrase 的密钥登录多台服务器很常见，管理成本最低。
- **为这台服务器单独生成**：用 `-f` 指定新文件名，避开默认路径：
```bash
ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519_myserver -C "deploy@my-server"
```

两种方式各有利弊。共用一把密钥管理简单，但它一旦泄露会波及所有服务器。按服务器分别生成密钥可以隔离影响范围，泄露后也能单独吊销，代价是多一层文件管理。

如果选择了单独命名，后文所有出现 `id_ed25519` 的位置都要替换成新文件名，包括部署和验证时的 `-i` 参数以及客户端 config 中的 `IdentityFile`。另外，非默认名称的密钥 ssh 不会自动尝试，必须在客户端 config 中通过 `IdentityFile` 显式指定。

**2. 把公钥部署到服务器**

```bash
ssh-copy-id -i ~/.ssh/id_ed25519.pub deploy@<服务器IP>
```

`ssh-copy-id` 会用当前还可用的密码登录一次，把公钥追加到服务器上的 `~/.ssh/authorized_keys`，并在需要时创建相关目录和文件，比手工复制更不容易出错。这里显式指定 `-i`，确保部署的是刚生成的这把公钥。不带 `-i` 时它会优先使用 ssh-agent 中已加载的密钥，如果 agent 里有多把密钥，可能把其他公钥也一并写入服务器。OpenSSH 默认开启 StrictModes，会检查这些路径的属主和写权限。如果家目录、`.ssh` 或 `authorized_keys` 能被其他用户写入，密钥就有被替换的风险，sshd 通常会拒绝使用它。检查的重点是"其他人不可写"和"属主正确"，不要求权限精确等于某个数值，但 700/600 是最稳妥的推荐值，部署后可以核对一次：

```bash
chmod 700 ~/.ssh
chmod 600 ~/.ssh/authorized_keys
ls -ld ~/.ssh ~/.ssh/authorized_keys    # 确认属主是登录用户本人
```

如果曾以 root 身份手工动过这些文件，还要检查属主：`chown -R deploy:deploy /home/deploy/.ssh`。

Linux、macOS、WSL 和 Git Bash 通常自带 ssh-copy-id。Windows 原生 PowerShell 的 OpenSSH 没有这个命令，可以用管道做等价替代：

```powershell
Get-Content "$HOME\.ssh\id_ed25519.pub" | ssh deploy@<服务器IP> "umask 077; mkdir -p ~/.ssh; cat >> ~/.ssh/authorized_keys"
```

`umask 077` 保证新建的目录和文件一开始就是收紧的权限，执行后同样做一遍上面的权限核对。

**3. 验证密钥登录已生效**

```bash
ssh deploy@<服务器IP>    # 此时应不再询问服务器密码（passphrase 是本地私钥的口令，不是服务器密码）
```

各平台的 OpenSSH 都会自动尝试默认路径下的 `id_ed25519`，通常不需要额外参数。如果仍被询问服务器密码，可以显式指定私钥，先排除路径方面的问题。Windows PowerShell 下写作：

```powershell
ssh -i $HOME\.ssh\id_ed25519 deploy@<服务器IP>
```

Linux/macOS 则是 `ssh -i ~/.ssh/id_ed25519 deploy@<服务器IP>`。如果显式指定能登录而默认调用不能，说明密钥不在默认路径，或者受到了 agent 干扰，此时可以用 `ssh -v` 查看客户端实际尝试了哪些密钥。另外，下一节要配置的客户端 `~/.ssh/config` 在 Windows 上同样有效，路径为 `$HOME\.ssh\config`（即 `C:\Users\<用户名>\.ssh\config`），写法完全一致。配置好之后，登录时就不再需要手动指定 `-i`。

**这一步没通过，绝对不要进行下一节。**

### 3.2 收紧 sshd 配置

Ubuntu 24.04 的 `/etc/ssh/sshd_config` 开头有一行 `Include /etc/ssh/sshd_config.d/*.conf`。我们不动主配置文件，把加固项写进 drop-in。这样做有两个好处：发行版升级时不会产生配置文件冲突，自己改了什么也一目了然。

**1. 先看一眼已有的 drop-in**

```bash
ls /etc/ssh/sshd_config.d/
cat /etc/ssh/sshd_config.d/*.conf
```

云镜像上大概率会看到一个 `50-cloud-init.conf`，内容是 `PasswordAuthentication yes`。这是 cloud-init 在初始化时写入的，也是"印象中 Ubuntu 默认关闭了密码登录，实际却还能用密码登录"的原因。**不要直接删除它**，cloud-init 的某些操作可能重新生成该文件，我们用加载顺序来覆盖它。

**2. 新建加固配置**

```bash
vim /etc/ssh/sshd_config.d/10-hardening.conf
```

```bash
# /etc/ssh/sshd_config.d/10-hardening.conf
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
MaxAuthTries 3
LoginGraceTime 30
X11Forwarding no
AllowUsers deploy
```

文件名里的 `10` 不是随手写的。sshd 按字典序读取 drop-in，且对同一配置项**首个出现的值生效**（first-match wins，这与多数软件"后加载覆盖先加载"的直觉相反）。`10-` 排在 `50-cloud-init.conf` 前面，我们的 `PasswordAuthentication no` 先被读到，cloud-init 那行就成为无效的重复声明。

各项说明：

- `PasswordAuthentication no`：关闭密码认证。这条生效后，sshd 根本不会走到验证密码这一步，针对密码的字典爆破也就无从下手。
- `KbdInteractiveAuthentication no`：关闭键盘交互式认证。PAM 可以通过这条通道提供口令、验证码等交互式认证方式。为了避免普通密码经由这条通道继续可用，需要与上一条一起关闭。
- `PermitRootLogin no`：root 完全不接受 SSH 登录，包括密钥登录。需要 root 权限时用普通用户登录后再 sudo，这一步会在日志中留下 sudo 提权记录，便于后续审计。
- `MaxAuthTries 3`：限制单次连接内的认证尝试次数。注意客户端每提交一把不匹配的密钥也计一次。ssh-agent 中有多把密钥时，客户端会逐把尝试，可能在轮到正确的密钥之前就达到上限，报 `Too many authentication failures`。因此收紧这个值的前提是客户端明确指定密钥（见下方客户端配置）。如果不想处理这个兼容问题，保留默认值 6 也完全可以。
- `LoginGraceTime 30`：连接建立后 30 秒内必须完成认证，否则断开。默认的 120 秒偏长，会让慢速攻击和半开连接长时间占用 sshd 资源。
- `X11Forwarding no`：服务器没有图形界面，这个转发通道属于多余的攻击面，关闭。
- `AllowUsers deploy`：白名单，只有列出的用户可以通过 SSH 登录。它和 `PermitRootLogin no` 有功能重叠，但白名单体现了默认拒绝的思路：以后系统里因为安装软件新增的服务账户，不会意外获得 SSH 入口。多个用户用空格分隔。

配合 `MaxAuthTries 3`，建议在客户端 `~/.ssh/config` 里为这台服务器写一段配置，把提交的密钥限定为这一把：

```bash
# 客户端 ~/.ssh/config
Host my-server
    HostName <服务器IP>
    User deploy
    IdentityFile ~/.ssh/id_ed25519
    IdentitiesOnly yes
    # Port 36022    # 若按 3.3 节修改了端口，再加这行
```

`IdentitiesOnly yes` 让客户端只提交 `IdentityFile` 指定的密钥，不再把 ssh-agent 里的密钥逐个尝试。这样既不会触发服务器的尝试次数上限，也省去了每次输入 IP 和用户名的麻烦，之后用 `ssh my-server` 即可登录。

你可能注意到配置里没有写 `AuthenticationMethods publickey`。在 Ubuntu 默认关闭其他认证方式（GSSAPI、host-based 等），且上面已经禁用密码和键盘交互的前提下，公钥实际上已经是唯一可用的登录方式，本文不再额外设置。`AuthenticationMethods` 的作用是明确限定认证流程或组合多因素，例如 `publickey,keyboard-interactive` 表示两种方式必须依次通过。PAM 层的 TOTP 走的就是后一条通道，这也是第 7 节提到的 2FA 方案的实现基础。

**3. 校验配置语法**

```bash
sshd -t
```

没有任何输出表示通过。**如果报错就停下来修好，此时旧配置仍在运行，不会有任何影响**。带着语法错误 restart，是把自己锁在门外的典型原因。

**4. 重启 sshd 并验证**

```bash
systemctl restart ssh
```

这里按 Ubuntu 官方文档的推荐，用 `systemctl restart ssh` 让 sshd 重新读取配置。默认配置下，已建立的连接由各自独立的 sshd 进程持有，重启负责接受新连接的服务通常不会断开这些连接。但不要把这个行为当成唯一的防锁死保障，保留旧终端、用新终端验证登录，这条纪律仍然必须遵守。另外需要区分一种情况：本节这些认证相关的参数，restart 服务即可生效。如果修改的是监听端口（Port / ListenAddress），还要额外处理 systemd 的 socket 单元。Ubuntu 从 22.10 起，ssh 默认采用 socket 激活，由 `ssh.socket` 监听端口，有连接进来才拉起 sshd，24.04 延续了这套机制，具体见下一节。

**保持当前会话不关，另开终端做两个验证**：

```bash
ssh deploy@<服务器IP>                                  # 密钥登录应正常
ssh -o PubkeyAuthentication=no deploy@<服务器IP>       # 强制不用密钥，应直接被拒绝：Permission denied (publickey)
```

第二条命令是在模拟攻击者的行为：禁用自己的密钥去连接，如果服务器仍然询问密码，说明配置没有生效，需要回头检查 drop-in 的文件名排序和拼写。两个验证都通过，SSH 加固才算完成。

### 3.3 关于修改 SSH 端口

个人认为全网段的扫描工具遍历全部端口只是时间问题，密钥认证才是真正起作用的防护。改端口的实际收益，是让日志里的爆破记录从每天几千条降到接近零。日志干净了，真正异常的访问才容易被发现。

如果要改，顺序很重要：**先放行新端口，再修改配置，验证通过后再关闭旧端口**。

**1. 先放行新端口**。在云安全组放行 36022/tcp。如果此时 ufw 已经处于启用状态（按本文顺序第 4 节还在后面，尚未启用则跳过这条），也先执行：

```bash
ufw limit 36022/tcp comment 'SSH'
```

**2. 修改配置并应用**。在 `10-hardening.conf` 里加一行：

```bash
Port 36022    # 1024–65535 之间自选，避开常见服务端口
```

```bash
sshd -t
systemctl daemon-reload
systemctl restart ssh.socket
```

注意这里多了 `daemon-reload`，重启对象也变成了 `ssh.socket`，原因就是上一节末尾提到的 socket 激活：监听端口的是 systemd 的 socket 单元，而不是 sshd 本身。24.04 提供了一个 systemd generator，会在 daemon-reload 时解析 sshd_config 中的 Port 指令并同步给 socket 单元，因此不需要像 22.10/23.04 那样手写 socket 的 override 文件。但 `daemon-reload` 这一步不能省，只 restart ssh 的话监听端口不会变化。

**3. 检查监听**：

```bash
systemctl status ssh.socket
ss -ltnp 'sport = :36022'
```

有一点需要注意：socket 激活模式下，`ss` 显示的监听进程可能是 systemd 而不是 sshd。监听 socket 本来就由 systemd 持有，这属于正常现象，如果习惯性地用 `ss -tlnp | grep ssh` 过滤，反而可能看不到结果。

![](https://img.gulugulublog.com/posts/ubuntu-2404-server-hardening/20260726200221148.png)

![](https://img.gulugulublog.com/posts/ubuntu-2404-server-hardening/20260726200242098.png)

**4. 验证后再关闭旧端口**。另开终端用 `ssh -p 36022` 登录，**在成功之前保留安全组里旧 22 端口的规则**。确认新端口登录无误后，再删除安全组（以及 ufw 里如有）的旧端口规则。

## 4 防火墙 ufw

ufw（Uncomplicated Firewall）是 iptables/nftables 的前端，Ubuntu 默认自带，规则语法直观。整体策略可以概括为一句话：**默认拒绝所有入站流量，按需逐条放行**。

**1. 设置默认策略**

```bash
ufw default deny incoming     # 入站默认拒绝
ufw default allow outgoing    # 出站默认放行
```

入站默认拒绝是整个防火墙策略的基础。出站保持放行是一个务实的取舍：服务器需要执行 apt 更新、拉取部署文件，fail2ban 也需要查询 DNS，如果逐条管理出站规则，维护成本会远高于它在个人服务器场景下的实际收益。出站管控主要应对主机被入侵后阻止外联的场景，这部分内容不在本文讨论范围内。

**2. 放行 SSH（在 enable 之前！）**

```bash
ufw limit 36022/tcp comment 'SSH'    # 端口按实际情况填写，未修改端口则为 22/tcp。若 3.3 节已提前添加，会提示规则已存在，跳过即可
```

这里使用 `limit` 而不是 `allow`：`limit` 在放行的基础上附带内置限速，同一 IP 在 30 秒内发起 6 次或更多新连接时会被临时拒绝。它与 fail2ban 构成互补的两层防护，`limit` 在内核层拦截高频连接，开销很低，fail2ban 则在应用层分析日志并执行较长时间的封禁。`comment` 的作用是为后续维护提供说明，之后执行 `ufw status` 时可以直接看清每条规则的用途。

**3. 启用**

```bash
ufw enable
```

执行后会警告可能中断现有 SSH 连接，确认上一步的放行规则无误后输入 y。`ufw enable` 会同时配置开机自启，不需要再单独处理 systemctl。

**4. 验证**

```bash
ufw status verbose
```

输出中应包含默认策略 `deny (incoming), allow (outgoing)`，以及 SSH 端口的 LIMIT 规则。Ubuntu 默认启用了 ufw 的 IPv6 支持（可用 `grep '^IPV6=' /etc/default/ufw` 核对），因此通常会看到 IPv4 和 IPv6 各一条规则。如果服务器持有公网 IPv6 地址，这一点尤其重要，只检查 IPv4 规则而忽略 IPv6 侧，会在防护上留下明显缺口。反过来，如果列表中只有 IPv4 规则，应先核对上述开关是否被镜像修改过，而不是怀疑自己的操作有误。

**关于业务端口**：现阶段**不要**提前放行任何尚未部署的服务端口（80、443 或其他应用端口）。防火墙规则应当跟随服务走，在服务安装完成、确认需要对外提供访问时，再执行对应的 `ufw allow`，这是"默认拒绝"原则的自然延伸。

**一个预警**：如果后续打算用 Docker 部署服务，需要注意 Docker 默认直接操作 iptables，通过 `-p 8080:8080` 发布的端口会**绕过 ufw** 直接暴露到公网，即使 ufw 中没有对应的放行规则也无法拦截。这是 Docker 与 ufw 共存时的一个已知问题。届时要么使用 `127.0.0.1:8080:8080` 绑定回环地址，再由反向代理转发，要么明确接受"Docker 发布的端口交由安全组管理"这一方案。

## 5 fail2ban

ufw 的 limit 只拦同一 IP 的高频新连接，fail2ban 则真正去读日志。认证失败次数达到阈值的来源 IP 会被防火墙直接封禁一段时间，因此它能处理低于连接限速阈值的慢速尝试。同时也要清楚它的边界，这种按 IP 统计的机制对频繁轮换 IP 或分布式僵尸网络效果有限。fail2ban 只是密钥认证和最小化暴露面之外的补充层，不能替代前两者。

**1. 安装**

```bash
apt install fail2ban -y
```

24.04 的 fail2ban 包已经依赖 `python3-systemd`（读取 journald 日志的 Python 绑定库），安装时会一并带上，不需要手动指定。sshd 的认证日志走 systemd journal，fail2ban 直接从 journal 读取，相比依赖 rsyslog 落盘的 /var/log/auth.log，少了一层间接依赖，也没有日志轮转的边界问题。

**2. 编写本地配置**

fail2ban 的配置是分层的。`jail.conf` 由发行版维护默认值，升级时会被覆盖，**永远不要直接改它**。本地定制写在 `jail.local`，同名配置项会覆盖 conf 里的值。

```bash
vim /etc/fail2ban/jail.local
```

```ini
# /etc/fail2ban/jail.local
[DEFAULT]

# 初始封禁时长
bantime = 1h

# 统计失败次数的时间窗口
findtime = 10m

# 窗口内允许的最大失败次数
maxretry = 5

# 同一 IP 累犯时封禁时长按 1、2、4、8……倍递增
bantime.increment = true

[sshd]
enabled = true
backend = systemd

# 与实际 SSH 端口一致，默认端口则写 ssh
port = 36022
```

注意这份配置里的注释全部独立成行，不要图省事写成行内 `# 注释`。fail2ban 的配置解析中 `#` 只用于整行注释，行内注释要用前面带空格的 `;`。把 `#` 写在参数值后面，有被当成参数值一部分解析的风险。

参数选择的理由：

- `maxretry = 5` / `findtime = 10m`：10 分钟内失败 5 次即封禁。正常的密钥登录不会产生认证失败记录，私钥 passphrase 在客户端本地验证，输错不会发到服务器，也就触发不了 fail2ban。客户端逐把提交不匹配的密钥，可能在服务器端产生失败记录，或者先触发 MaxAuthTries，3.2 节的 `IdentitiesOnly yes` 正好可以避免这类问题。爆破脚本则几秒内就会触发阈值。
- `bantime = 1h` 起步配合 `bantime.increment`：首犯 1 小时足够让绝大多数扫描脚本放弃并转向下一个目标，顽固的 IP 会被递增机制越封越久。不建议一上来就设置一周这种极端值，长封禁的代价是你自己某天误触发时，解封之前从这个 IP 完全进不来。
- `port` 必须与实际 SSH 端口一致。fail2ban 封禁时下发的规则针对具体端口，改了 SSH 端口却忘了同步这里，封禁规则会打在无人使用的 22 端口上，形同虚设。

**3. 启用并验证**

```bash
fail2ban-client -t
systemctl enable --now fail2ban
fail2ban-client status sshd
```

`fail2ban-client -t` 与前文的 `sshd -t` 是同一个习惯，先测配置，再启动服务。看到 `OK: configuration test is successful` 再继续，报错就按输出里的文件名和行号修正 `jail.local`，不要带着错误配置启动。

实测在输出 OK 之前还会出现一行 WARNING：`'allowipv6' not defined in 'Definition'. Using default one: 'auto'`。这是 24.04 自带的 fail2ban 1.0.x 的已知提示，不影响功能。它的含义是 IPv6 支持未显式配置，将按 auto 自动检测，配置是否通过仍以最后那行 OK 为准。如果希望输出保持干净，可以把这个默认值显式写出来：

```bash
tee /etc/fail2ban/fail2ban.local <<'EOF'
[Definition]
allowipv6 = auto
EOF
```

注意这项写在 `fail2ban.local`，而**不是** `jail.local`。它属于 fail2ban 守护进程本身的配置（对应 `fail2ban.conf`），与 jail 规则分属两个文件，分层逻辑与 jail.conf/jail.local 相同：conf 归发行版，local 归自己。写完后重新执行 `fail2ban-client -t`，WARNING 应消失。

输出里 `Currently banned` 和 `Total banned` 一开始都是 0，属于正常。放一天再看，Total banned 的数字会直观反映这层防护拦下了多少东西。如果 sshd jail 启动时报找不到日志，检查 `backend = systemd` 是否写在 `[sshd]` 段内，以及 python3-systemd 是否已经安装。

**误封自己怎么办**：从云厂商的网页控制台（VNC/串口，不走 SSH 也就不受 fail2ban 管）登录，执行 `fail2ban-client set sshd unbanip <你的IP>`，或者干脆换个出口 IP，比如切到手机热点，绕开封禁。

## 6 自动安全更新 unattended-upgrades

系统加固不是一次性工作，安全补丁会持续发布。对于不希望每天手动维护的个人服务器，将安全更新交给 unattended-upgrades 自动处理，整体收益大于风险。

**1. 确认已安装并启用**

```bash
apt install unattended-upgrades -y    # Ubuntu Server 通常已预装
systemctl status unattended-upgrades
```

**2. 检查周期任务配置**

```bash
cat /etc/apt/apt.conf.d/20auto-upgrades
```

应包含以下两行，没有则补上：

```bash
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
```

这两项分别表示每天刷新软件包索引、每天执行一次无人值守升级。实际执行由 `apt-daily.timer` 与 `apt-daily-upgrade.timer` 调度，并带有随机延迟，以避免大量机器在同一时间访问镜像源，因此不会在每天固定时刻运行。可以通过 `systemctl list-timers 'apt-daily*'` 查看下一次的执行时间。

**3. 核对升级范围**

```bash
vim /etc/apt/apt.conf.d/50unattended-upgrades
```

默认的 `Allowed-Origins` 包含当前发行版的基础仓库（`${distro_id}:${distro_codename}`）、安全更新源 `${distro_codename}-security`，以及系统具备 Ubuntu Pro 资格时对应的 ESM 安全源。普通功能更新源 `${distro_codename}-updates` 默认保持注释。基础仓库在版本发布后内容基本不再变化，因此日常持续自动安装的实际就是安全更新。功能更新可能改变软件行为，应由管理员在合适的时间手动执行 `apt upgrade`。具体以机器上这份文件的实际内容为准。

另外确认一项：

```bash
//Unattended-Upgrade::Automatic-Reboot "false";
```

保持注释状态，即不自动重启。内核安全更新需要重启才能生效，但对外提供服务的机器在半夜自动重启会直接中断所有在线业务，是否重启应由管理员决定。折中做法是登录时留意 motd 中的 `*** System restart required ***` 提示，选择低峰时段手动重启。

另一个 24.04 上容易忽略的行为：`Automatic-Reboot "false"` 只控制整机重启，不控制服务重启。24.04 默认安装 needrestart，它可能在升级完成后自动重启需要重新加载库文件的 systemd 服务，在线业务仍可能出现短暂中断。如果希望改为只提示而不自动重启服务，可以执行：

```bash
mkdir -p /etc/needrestart/conf.d
tee /etc/needrestart/conf.d/99-local.conf <<'EOF'
$nrconf{restart} = 'l';
EOF
```

`l` 表示 list，即只列出需要重启的服务，由管理员自行处理。是否修改需要权衡。自动重启服务可以让补丁及时生效，只提示则把中断时机的控制权留给管理员，但要注意，此时补丁只是写入磁盘，相关进程仍在使用内存中的旧版本，直到手动重启服务后修复才真正生效。对于单人维护、可以接受短暂中断的机器，建议保持默认让 needrestart 自动重启服务。对服务连续性有要求的场景，可以改为 `l` 并配合固定的维护窗口处理。

**4. 模拟运行测试**

```bash
unattended-upgrade --dry-run --debug
```

`--dry-run` 只模拟不执行，输出中可以看到识别了哪些源、当前有哪些包会被自动升级，用于确认逻辑符合预期。

## 7 本文没做什么，以及为什么

- **SSH 2FA（TOTP）**：带 passphrase 的私钥能降低私钥文件泄露后被直接滥用的风险。需要指出的是，passphrase 只在客户端本地解锁私钥，服务器无法确认它是否存在，因此它并不等同于服务器强制实施的第二因素。对本文面向的个人服务器而言，强密钥配合 passphrase，再加上客户端自身的安全，已经是合理的取舍。有更高需求时，可以再配置 publickey 与 TOTP 的叠加认证，或者改用硬件保护的 FIDO2 安全密钥。
- **端口敲门（port knocking）**：隐蔽性带来的收益低于维护成本，对客户端也不够友好。在已经启用密钥认证的前提下，它要解决的问题基本不存在。
- **rootkit 扫描器（rkhunter/chkrootkit）**：这类工具误报率高，规则更新也不及时，在机器未沦陷的前提下价值有限。如果真的怀疑机器已经沦陷，正确的做法是取证后重装系统，而不是在原地清理。
- **SELinux / AppArmor 调整**：Ubuntu 默认已启用 AppArmor，并为常见服务加载了配置文件，保持默认即可，无需额外操作。
- **修改内核 sysctl 网络参数**：常见加固教程里的不少设置，例如启用 SYN cookies，Ubuntu 默认已经处理。另一些参数（如 rp_filter）的合理取值与网卡数量、策略路由、容器和 VPN 拓扑相关，没有通用的"安全值"。在没有明确威胁模型和业务需求的情况下，不建议机械照抄一整套参数，轻则造成重复配置，重则破坏正常的路由或连接。

## 8 验证速查

全部做完后，可以用这几条命令快速核对整体状态：

```bash
sudo sshd -T | grep -Ei '^(port|passwordauthentication|kbdinteractiveauthentication|permitrootlogin|maxauthtries|logingracetime|x11forwarding|allowusers)\b'   # sshd 最终生效配置
sudo ss -tulpn                            # 当前监听端口（TCP + UDP）
sudo ufw status verbose                   # 防火墙默认策略与规则
sudo fail2ban-client status sshd          # 封禁统计
lastb | head                              # 最近的失败登录尝试
last | head                               # 最近的成功登录，确认没有陌生记录
cat /var/run/reboot-required 2>/dev/null  # 是否有待重启的更新
```

监听端口的检查重点是绑定在 `0.0.0.0` 和 `[::]` 上的公网监听。云镜像通常自带监控代理、时间同步等组件，监听列表里不会只有 SSH 一项，这属于正常现象。绑定在 `127.0.0.1`、`::1` 或内网地址上的服务，结合用途判断即可。对于无法识别的公网监听，可以根据 `ss` 输出中的进程名进一步确认它的来源和用途。

`sshd -T` 需要单独说明。它输出的是所有配置文件合并、first-match 规则应用之后**实际生效**的完整配置。排查"修改后没有生效"这类问题时，以它的输出为准比直接查看配置文件更可靠。另外，`sshd -T` 显示的是全局配置，如果配置中包含 Match 段，需要用 `-C` 指定用户、来源地址等连接条件，才能看到对应连接实际匹配的结果。

## 结语

至此，我们完成了以下配置：

- 系统补丁更新与重启
- 普通用户 + sudo，root 不再用于日常登录
- SSH 仅密钥登录、禁止 root、限制重试（可选改端口降噪）
- ufw 默认拒绝入站，SSH 端口限速放行
- fail2ban 基于日志的自动封禁
- 安全更新自动化，整机重启由人工安排，服务重启按 needrestart 策略处理

这台服务器现在已经可以放心部署业务了。

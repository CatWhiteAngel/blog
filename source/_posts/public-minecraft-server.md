---
title: 在加固过的 Ubuntu 上运营 Minecraft 服务器——双实例架构实践
date: 2026-07-29 10:19:00
categories: [Web Services]
tags: [Minecraft, Fabric, Game Server, Systemd, Ubuntu]
description: 在一台独立 VPS 上搭建公开的 Minecraft 纯净生存服务器：Fabric 服务端配合纯服务端性能与管理模组，玩家用原版客户端即可加入；systemd 服务化、优雅停机、自动备份，以及一个按需启动、仅限内部朋友的群峦：重生整合包副服。
---

# 在加固过的 Ubuntu 上运营 Minecraft 服务器——双实例架构实践

这台服务器的定位很明确：公开、正版验证、纯净生存。玩家不需要安装任何额外内容，使用原版客户端输入地址即可加入。这一体验能够成立，依赖于一个常被忽视的事实：**Fabric 的纯服务端模组（server-side mods）对客户端完全透明**。Lithium、Ledger 这类模组只在服务端运行，不注册任何新方块、新物品或新的数据包内容，客户端无法感知它们的存在。因此，安装了模组的服务器与原版玩法并不矛盾，前提是模组的选择足够克制。

本文记录完整的搭建过程，包括 Fabric 服务端部署、模组选择的理由、systemd 服务化与优雅停机、自动备份，以及同一台机器上一个按需启动的整合包副服，即群峦：重生（TerraFirma: Rebirth）。副服与主服定位不同，仅面向朋友开放，启用白名单准入，不对外公开。所使用的机器是一台独立的 Ubuntu 24.04 VPS，也就是[《云服务器到手第一件事——Ubuntu 24.04 安全加固实操》](https://www.catwhiteangel.com/ubuntu-2404-server-hardening/)一文中完成加固的那一台。该文结尾提到「这台服务器现在已经可以放心部署业务了」，本文所述即为在这台机器上部署的第一个业务。系统更新、SSH 密钥登录、ufw、fail2ban 与自动安全更新均已配置完成，本文不再重复，直接从部署开始。

<!-- more -->

## 1 整体架构与三个前置判断

开工前先把三个影响全局的判断说清楚。

**第一，这台机器上会同时存在两套 Java。** 主服运行当前正式版 Minecraft 26.2（2026 年 6 月发布），官方运行环境从 26.1 起已升级到 Java 25。副服的群峦：重生基于 1.20.1 Forge，按 Java 17 部署，Forge 1.20.1 生态的标准环境就是 Java 17，换用更新的 Java 可能因 Forge 或个别模组的兼容性问题启动失败，一切以服务端包的说明和实际测试为准。两套 JRE 并存本身没有问题，问题在于 `java` 命令只能指向其中一个，因此后文所有 systemd 单元里的 Java 一律写绝对路径，不依赖 `update-alternatives` 的全局默认。

```bash
sudo apt install openjdk-25-jre-headless openjdk-17-jre-headless
# 两个路径，后面 systemd 单元里直接引用：
# /usr/lib/jvm/java-25-openjdk-amd64/bin/java
# /usr/lib/jvm/java-17-openjdk-amd64/bin/java
```

**第二，公开服的威胁模型要在动手前想清楚。** Minecraft 默认端口 25565 是被扫描最频繁的游戏端口之一，有团体使用 masscan 之类的工具对全网段进行扫描，专门寻找关闭了正版验证（`online-mode=false`）的服务器。在盗版模式下，任何人都可以用任意用户名登录，包括管理员的名字。所以 `online-mode=true` 是公开服务器最基础的一道认证防线。它无法阻止恶意的正版玩家实施破坏。对这类行为的应对不是事前拦截（那需要领地或保护插件，会改变原版玩法），而是事后处置：Ledger 提供操作日志与回滚，定时备份提供最后的退路，`/ban` 用于处理当事人。概括来说，这台服务器的管理思路是**保留退路，而不是加高门槛**。

**第三，两个实例用两个系统用户，目录分开不等于隔离。** 如果两个实例共用一个用户，目录再怎么分开也只是整洁，不构成安全边界：任一实例的进程都能读写另一个实例的全部文件。主服常年暴露在公网，副服运行的是第三方整合包的大量代码，这条边界值得用两条 `useradd` 明确建立。备份目录归 root 且权限收紧到 0700，两个游戏用户既不能修改也无法读取备份内容，实例内的任何代码都无法触及这份退路。

```
/opt/minecraft/
├── fabric/        # 主服：Fabric 26.2，常驻，公开，属主 minecraft-fabric
├── tfcr/          # 副服：群峦：重生（Forge 1.20.1），按需启动，仅限朋友，属主 minecraft-tfcr
└── backups/       # 备份输出目录，属主 root，0700
```

```bash
sudo mkdir -p /opt/minecraft
sudo useradd -r -m -d /opt/minecraft/fabric -s /usr/sbin/nologin minecraft-fabric
sudo useradd -r -m -d /opt/minecraft/tfcr -s /usr/sbin/nologin minecraft-tfcr
sudo chmod 0700 /opt/minecraft/fabric
sudo chmod 0700 /opt/minecraft/tfcr
sudo install -d -o root -g root -m 0700 /opt/minecraft/backups
```

那两条 `chmod` 不是多余的。`useradd -m` 创建家目录时采用的权限取决于系统的 `HOME_MODE`／`UMASK` 配置，不能假定它一定是私有目录。不显式收紧的话，另一个游戏用户虽然无法写入，仍可能读取这边的世界存档、配置和名单文件，「互相不可读写」的边界就只实现了一半。日后若需要让专门的运维组读取，改为 `0750` 并配置一个独立管理组即可。

## 2 Fabric 服务端

**1. 下载服务端启动器。** 通过 Fabric 官方 Meta API 可以直接生成一个可执行的小型服务端启动器（server launcher）jar，不需要运行图形化 installer。注意它不是包含全部依赖的自包含 jar，首次运行时会联网下载对应版本的 Minecraft 服务端与 Fabric Loader 文件。三个版本号从 [fabricmc.net/use/server](https://fabricmc.net/use/server/) 页面查看当前推荐组合：

```bash
sudo -u minecraft-fabric curl -fL -o /opt/minecraft/fabric/fabric-server-launch.jar \
    "https://meta.fabricmc.net/v2/versions/loader/26.2/0.19.3/1.1.2/server/jar"
```

`-f` 让 HTTP 4xx/5xx 直接以失败返回，避免把错误页面保存成一个假 jar。`-L` 允许跟随重定向。

这里命名为 `fabric-server-launch.jar`，后面 systemd 单元引用的就是这个固定文件名。但要注意，将来升级 Minecraft 版本时，仍须先备份世界，并核对 Loader、Fabric API 与全部模组是否都有兼容构建。26.1 这类技术性改动很大的版本尤其如此，不能覆盖完启动器就直接开旧世界。

**2. 首次启动，接受 EULA。**

```bash
sudo -u minecraft-fabric sh -c 'cd /opt/minecraft/fabric && \
    exec /usr/lib/jvm/java-25-openjdk-amd64/bin/java -jar fabric-server-launch.jar nogui'
```

第一次运行会先下载 Minecraft 服务端与 Loader 文件，然后因未接受 EULA 退出并生成 `eula.txt`，这是预期行为：

```bash
sudo -u minecraft-fabric sed -i 's/eula=false/eula=true/' /opt/minecraft/fabric/eula.txt
```

**3. 再启动一次，生成配置与世界。** 把上面那条 java 命令原样再执行一遍，这次会生成 `server.properties` 和世界文件。等日志出现 `Done` 后在控制台输入 `stop` 正常关闭。之所以先在前台手动运行而不是直接交给 systemd，是为了先确认服务端能干净地启动和停止，先验证配置，再启用服务。接下来的配置都在停止状态下修改。

### server.properties 关键项

```bash
sudoedit /opt/minecraft/fabric/server.properties
```

大部分配置项保持默认即可，这里只列出需要修改或需要说明的几项：

```properties
online-mode=true
```

默认值就是 true，这里列出来是为了强调：**这一项在公开服上没有任何商量余地**，理由见前文威胁模型。

```properties
view-distance=10
simulation-distance=10
```

视距（view distance）决定向客户端发送多远的区块，模拟距离（simulation distance）决定服务端实际运算（生物、红石、作物生长）多远的区块。单个玩家可能加载的区块数量大致随距离的平方增长，但实际 CPU 与内存消耗还受玩家区域重叠、生物数量、红石装置和新区块生成等因素影响。默认的 10 在小型服务器上是合理起点。如果后续 spark 剖析显示压力大，优先降低 `simulation-distance`，它对性能的影响更直接，而降低视距会直接反映在玩家画面上。

```properties
white-list=false
enforce-whitelist=false
```

公开服不开白名单。管理手段是原版自带的 `/op`、`/ban`、`/ban-ip`、`/banlist`，加上下文的 Ledger。`motd`、`max-players`、`difficulty` 按喜好设置，不展开。

最后是一项**可选**调优，本文默认不动它：

```properties
sync-chunk-writes=true    # 默认值，保持不变，以下讨论的是改 false 的条件
```

`true` 表示每次区块写入都同步落盘（fsync），最稳但慢，在机械盘或低配 VPS 上可能造成可感知的保存卡顿。改为 `false` 后写入交给操作系统缓存，性能改善明显。代价需要明确：断电或内核崩溃时，最近写入的区块数据可能损坏，**损坏范围无法精确限定**。每日备份意味着极端情况下损失接近一天进度，而且备份的存在并不降低当前存档损坏的概率本身。所以顺序必须是先用默认值运行，只有当 spark 确认保存写入是卡顿来源，并且停机验证和至少一次备份恢复演练都已完成之后，才考虑用这项风险换取性能。

### 模组清单

原则只有一条：**只装纯服务端、且明确以不改变原版行为为目标的模组**。每装一个都要确认它不会让某个红石机器或刷怪塔的行为和原版不一致。安装前在 Modrinth 对应页面核对是否已支持当前 MC 版本，性能类模组在新版本发布后跟进速度不一，装了不匹配的版本轻则不加载，重则崩溃。

**基础依赖：**

- **Fabric API** 和 **Fabric Language Kotlin**。它们自身不提供任何玩家可见的功能，是下面多个模组声明的前置依赖（Ledger 同时需要这两个）。装模组不能只装主体 jar，要以每个模组 Modrinth 版本页的 Dependencies 标签为准，把标注 required 的依赖一并装齐。

**性能优化：**

- **Lithium**：游戏逻辑层的性能优化（实体 AI、碰撞、区块 tick 等）。它的开发原则是与原版行为严格一致（vanilla parity），这正是纯净服可以放心使用它的原因。
- **FerriteCore**：降低内存占用，对小内存 VPS 尤其有价值，不改变游戏行为。

**管理与观测：**

- **spark**：性能剖析器（profiler）。它不优化任何东西，但当服务器卡顿时，`/spark profiler` 能定位卡顿的来源，而不是靠猜测。对公开服来说，可观测性本身就是必需品。
- **Ledger**：方块操作日志与回滚。`/ledger inspect` 切换检查模式后敲掉一个方块，就能看到它的完整操作历史（谁放的、谁破坏的、什么时间）。`/ledger rollback` 按玩家、时间范围、区域回滚破坏。这是公开服事后处置策略的核心工具，没有它，遇到恶意破坏只能整服回档，全体玩家的进度都会受牵连。

**放置模组文件。** 模组 jar 全部放进 `mods/` 目录（首次启动时已自动创建），重启即加载。在 Modrinth 各模组页面选中与 MC 版本匹配的构建，复制该版本的 `.jar` 下载直链：

```bash
sudo -u minecraft-fabric sh -c \
    'cd /opt/minecraft/fabric/mods && curl -fLO "<Modrinth 版本页复制的 .jar 直链>"'    # 每个模组一条
```

```bash
sudo -u minecraft-fabric sh -c \
    'cd /opt/minecraft/fabric/mods && curl -fLO "https://cdn.modrinth.com/data/P7dR8mSH/versions/3gT0I5vt/fabric-api-0.156.0%2B26.2.jar"'
sudo -u minecraft-fabric sh -c \
    'cd /opt/minecraft/fabric/mods && curl -fLO "https://cdn.modrinth.com/data/Ha28R6CL/versions/bdhiINYC/fabric-language-kotlin-1.13.13%2Bkotlin.2.4.10.jar"'
sudo -u minecraft-fabric sh -c \
    'cd /opt/minecraft/fabric/mods && curl -fLO "https://cdn.modrinth.com/data/gvQqBUqZ/versions/f7vZ0VWU/lithium-fabric-0.25.3%2Bmc26.2.jar"'
sudo -u minecraft-fabric sh -c \
    'cd /opt/minecraft/fabric/mods && curl -fLO "https://cdn.modrinth.com/data/uXXizFIs/versions/d5ddUdiB/ferritecore-9.0.0-fabric.jar"'
sudo -u minecraft-fabric sh -c \
    'cd /opt/minecraft/fabric/mods && curl -fLO "https://cdn.modrinth.com/data/l6YH9Als/versions/iYFOl6lQ/spark-1.10.173-fabric.jar"'
sudo -u minecraft-fabric sh -c \
    'cd /opt/minecraft/fabric/mods && curl -fLO "https://cdn.modrinth.com/data/LVN9ygNV/versions/KpVLPOJk/ledger-1.3.23.jar"'
```

完整性不要靠数 jar 个数判断，应对照各模组的 Dependencies 页面逐个核对依赖是否装齐。放完再前台启动一次。日志开头会打印加载的模组数量与名字，缺前置的模组会明确报 `requires ...` 并拒绝启动，逐个核对无误后 `stop`，然后进入下一节的 systemd 服务化。

## 3 systemd 服务化与服务停机

对 Minecraft 服务端来说，向控制台发送 `stop` 是最明确的正常关闭方式，日志中可以看到完整的 `Saving chunks` 保存流程，关闭是否完整可以直接验证。SIGTERM 下 HotSpot JVM 通常也会通过关闭钩子正常退出，但保存是否完整无法从外部确认，因此本文不依赖信号语义，而是显式发送 `stop`。

向控制台发送命令的通道，本文选择 systemd 的 FIFO socket 而不是常见的 RCON。RCON 需要在配置中保存明文密码，并且要多监听一个端口，即使只绑定 127.0.0.1 也不例外。FIFO 方案不占用端口，也不需要密码，权限由文件系统控制，同时还带来一个实用的附带能力：**可以随时从 shell 向服务器控制台发送任意命令**，日常管理操作都可以经由这条通道完成。它的局限是单向的，只能发送命令而读不到回执，回执需要从 journald 日志中查看。这个局限对管理命令可以接受，但对需要确认执行结果的场景不适用，这一点会直接影响后文备份方案的选择。

`/etc/systemd/system/minecraft-fabric.socket`：

```ini
[Unit]
Description=Minecraft Fabric server console FIFO

[Socket]
ListenFIFO=/run/minecraft-fabric.stdin
SocketMode=0600
SocketUser=minecraft-fabric
RemoveOnStop=true

[Install]
WantedBy=sockets.target
```

注意 `[Install]` 段不能省略。没有安装信息的单元会被 `systemctl enable` 静默忽略，主服务的 `Requires=` 虽然照样能把 socket 带起来，开机不会失败，但 socket 并未真正被单独启用。挂到 `sockets.target` 是 systemd 对可启用 socket 的标准写法。

`/etc/systemd/system/minecraft-fabric.service`：

```ini
[Unit]
Description=Minecraft Fabric server
Requires=minecraft-fabric.socket
After=network.target minecraft-fabric.socket

[Service]
User=minecraft-fabric
WorkingDirectory=/opt/minecraft/fabric
ExecStart=/usr/lib/jvm/java-25-openjdk-amd64/bin/java -Xms1G -Xmx4G -jar fabric-server-launch.jar nogui
StandardInput=socket
StandardOutput=journal
StandardError=journal
ExecStop=/bin/sh -c 'if [ -n "$MAINPID" ] && kill -0 "$MAINPID" 2>/dev/null; then printf "stop\n" > /run/minecraft-fabric.stdin; while kill -0 "$MAINPID" 2>/dev/null; do sleep 1; done; fi'
TimeoutStopSec=420
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
```

几点说明：

- **Java 路径是绝对路径**，指向 Java 25，原因见开头。
- **内存设置为 `-Xms1G -Xmx4G`，GC 不加任何参数，使用 Java 25 的默认策略。** 上限按机器实际内存确定，至少给操作系统留出 1G，堆外内存（JVM 自身、直接缓冲区）也会额外占用。这里有一点容易误解：Minecraft 26.1 的官方启动器配置确实转向了更大的默认堆与分代 ZGC，但那是启动器注入的 JVM 参数。像本文这样直接运行专用服务端，不会自动继承启动器的任何配置，这条命令实际生效的是 JDK 自身的默认垃圾收集器。合理的做法是先用默认配置运行，通过 spark 和 GC 日志观察实际表现。以后如果想使用 ZGC，应显式添加参数并用监测验证效果，而不是因为客户端启动器采用了它就直接照搬。社区流传的 Aikar 参数集同理，它源自 Paper 生态的 G1 时代，是确认存在 GC 停顿问题之后的可选项，不是必要配置。
- **`ExecStop` 的写法是本节最容易出错的地方。** 直觉的写法是把 `stop` 写进 FIFO 就返回，但这样 systemd 会认为停止流程已经执行完毕，随即按 KillMode/KillSignal 处理尚未退出的 Java 进程，`TimeoutStopSec` 没有生效的机会。因此这条命令在发送 `stop` 之后轮询等待主进程真正退出（`$MAINPID` 由 systemd 在执行前替换为主进程 PID），此时 `TimeoutStopSec` 才是实际的保存时限，超时仍未退出才会被 SIGKILL。开头对 `$MAINPID` 的存在性检查同样不能省略。`ExecStop=` 不只在管理员停服时运行，Java 崩溃或自行退出后的停止阶段也会执行它。如果此时无条件写 FIFO，等于向无人读取的管道写入一条过期的 `stop`，socket activation 或 `Restart=on-failure` 拉起的下一个实例读到之后会立刻正常退出，自动恢复机制就此失效。
- **`TimeoutStopSec=420` 的取值有明确依据。** 停机时除了世界保存，Ledger 还可能等待尚未落库的操作队列写完，其默认等待上限约 5 分钟。systemd 给出的时限必须比组件自身的收尾预期更长，否则会在 Ledger 收尾进行到一半时强制终止进程。420 秒为世界保存与 Ledger 收尾都留出了余量，实际停机通常远快于这个上限。

启动并验证停止流程。**先手动验证停机可靠，再交给系统托管**，重启机器前必须确认这一点，否则每次 reboot 都相当于一次强制终止：

验证要看日志，而管理账号默认只能读自己的用户日志，先把它加进 `systemd-journal` 组（退出重新登录后生效；选这个组而不是 `adm` 是最小权限考虑，前者只给日志读取）：

```bash
sudo usermod -aG systemd-journal deploy
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now minecraft-fabric.socket minecraft-fabric.service
journalctl -u minecraft-fabric -f        # 观察启动完成
sudo systemctl stop minecraft-fabric     # 日志里应看到 Saving chunks 等完整关闭流程后进程才退出
```

一条运维备注：单独执行 `systemctl stop minecraft-fabric` 之后，已启用的 socket 仍在监听，此后任何对 FIFO 的写入都会通过 socket activation 把服务器重新拉起。需要彻底停机维护时，service 与 socket 要一起停：

```bash
sudo systemctl stop minecraft-fabric.service minecraft-fabric.socket
```

写在同一条命令里，systemd 会按依赖反向排序，先等 service 执行完 `ExecStop` 的保存流程，再关闭并移除 FIFO。由于配置了 `RemoveOnStop=true`，`/run/minecraft-fabric.stdin` 消失即代表 socket 已经停止。维护结束后执行 `systemctl start minecraft-fabric` 即可恢复，`Requires=` 会自动带起 socket。

日常从 shell 发控制台命令，第一件事就是给自己上管理员：

```bash
echo "op <你的正版ID>" | sudo tee /run/minecraft-fabric.stdin
echo "say 服务器将于 10 分钟后重启" | sudo tee /run/minecraft-fabric.stdin
# FIFO 是单向的，命令的执行结果在 journalctl -u minecraft-fabric 中查看
```

## 4 自动备份

Ledger 能回滚玩家行为，但回滚不了区块损坏、误操作删档和硬件故障，备份才是最后的退路。方案是**每日凌晨短暂停机冷备份**，而不是常见的 `save-off` 热备份。理由是可验证性：停机后文件不再变化，备份的一致性可以直接推理出来。热备份必须收到 `save-all flush` 的完成回执才算严谨，而本文的 FIFO 是单向管道，读不到回执，靠 `sleep` 估算完成时间做出的备份只能算大概率没问题，但大概率不该是备份的形容词。代价是每天停机几分钟（打包耗时），安排在凌晨执行，社区规模的服务器完全可以接受。若日后必须不停机备份，届时改用 RCON 读取回执再做，不在本文范围。

备份范围直接取**整个实例目录**，而不是白名单式地挑文件。灾难恢复需要的是能原样把服务器拉起来的全部状态，而手写清单迟早会过时：将来新增的配置文件不会自动进入清单，漏掉的那个恰好会在恢复那天被发现。整目录打包自动涵盖 `world`、`server.properties`、名单文件、`config/`、`mods/`（兼作当时模组版本的清单）、`eula.txt`、启动器 jar 与 Loader 文件、`usercache.json`，以及一切日后新增的内容，排除的只有可再生的日志与崩溃报告。Ledger 在默认配置下数据库位于世界目录内，随 `world` 一起被覆盖。如果改过 `config/ledger.toml` 的 `database.location`，需要确认自定义路径也在实例目录内，否则单独加进备份。`tar --zstd` 需要系统安装 zstd：

```bash
sudo apt install zstd
```

`/opt/minecraft/backup-fabric.sh`：

```bash
#!/bin/bash
set -euo pipefail
umask 077

SVC=minecraft-fabric
SRC=/opt/minecraft/fabric
DEST=/opt/minecraft/backups
STAMP=$(date +%Y%m%d-%H%M%S)
FINAL="$DEST/fabric-$STAMP.tar.zst"
TEMP="$DEST/.fabric-$STAMP.tar.zst.part"

WAS_ACTIVE=0
WAS_SOCKET_ACTIVE=0
cleanup() {
    rc=$?

    # 先解除 trap 并关闭 errexit：
    # 否则 rm 一旦失败，set -e 会让后面的重启逻辑根本执行不到
    trap - EXIT
    set +e

    rm -f "$TEMP"

    if [ "$WAS_ACTIVE" -eq 1 ]; then
        if ! systemctl start "$SVC"; then
            echo "ERROR: backup finished, but $SVC failed to restart" >&2
            rc=1
        fi
    elif [ "$WAS_SOCKET_ACTIVE" -eq 1 ]; then
        if ! systemctl start "$SVC.socket"; then
            echo "ERROR: backup finished, but $SVC.socket failed to restart" >&2
            rc=1
        fi
    fi

    exit "$rc"
}
trap cleanup EXIT

# is-active 只认 active，不认 activating：备份撞上服务器
# 正在启动的瞬间时，不能把「还在加载世界」误判成「没在运行」
SERVICE_STATE=$(systemctl show --property=ActiveState --value "$SVC")
case "$SERVICE_STATE" in
    active|activating|reloading)
        WAS_ACTIVE=1
        ;;
esac

if systemctl is-active --quiet "$SVC.socket"; then
    WAS_SOCKET_ACTIVE=1
fi

# service 与 socket 放进同一个 stop 事务：
# 避免先停 service、后停 socket 之间出现被再次激活的窗口
systemctl stop "$SVC" "$SVC.socket"

tar --zstd -cf "$TEMP" \
    --exclude='./logs' \
    --exclude='./crash-reports' \
    --exclude='./debug' \
    -C "$SRC" .

tar -tf "$TEMP" >/dev/null    # 校验压缩包完整可读
mv "$TEMP" "$FINAL"           # 校验通过才原子改名为正式文件

# 保留 14 天
find "$DEST" -name 'fabric-*.tar.zst' -mtime +14 -delete
```

这个脚本对几种失败模式做了显式设计。**残缺备份**：如果磁盘写满或压缩中途失败，直接写正式文件名会留下一个看起来像备份的残缺压缩包，等到恢复时才发现是最坏的情况。所以先写 `.part` 临时文件，`tar -tf` 校验完整可读后才原子改名，失败的临时文件由 cleanup 清掉。备份目录里凡是正式命名的文件，都在创建时通过了完整可读校验（这防不了创建之后的磁盘损坏或静默位翻转，那部分由异地副本负责）。**误判运行状态**：`is-active` 只认 active 不认 activating，备份恰好撞上服务器正在启动的瞬间时，会把「还在加载世界」误判成「没在运行」，然后开始打包一个正在写入的实例。所以用 `systemctl show` 取 ActiveState，把 activating 和 reloading 都算作「备份前在运行」。**服务器没被拉回来**：cleanup 在任何退出路径上都会把状态恢复到备份之前。service 之前在运行就 `start` service（`Requires=` 会带起 socket），只有 socket 活跃（比如 Java 启动失败、service 处于 failed 而 socket 还在等待激活）就单独恢复 socket。这句承诺能成立，靠的是函数开头那两行：先解除 trap，再 `set +e`。否则 `set -e` 在 trap 函数里依然生效，`rm` 若因只读文件系统之类的原因失败，重启逻辑根本轮不到执行。启动失败也**不**被吞掉：脚本以非零退出，备份单元进入 failed 状态，`journalctl` 和监控都能看到。写 `|| true` 把失败按下去，那不叫兜底，叫掩耳盗铃。**备份期间被意外唤醒**：socket 不停的话 FIFO 还在监听，此时任何人往里写命令，socket activation 会把服务重新拉起来，停机后文件不再变化的前提就不成立了。所以 service 与 socket 停在同一个 `systemctl stop` 事务里，连先停 service、再停 socket的间隙窗口也一并消除。systemd 会按依赖排序反向执行，先让服务走完 `ExecStop`，再关闭并移除 FIFO。顶部的 `umask 077` 让新生成的压缩包自身就是 0600，不把机密性只押在父目录的 0700 上。

热备份还存在一种本方案天然不会出现的隐蔽失败：`save-off` 之后脚本中途退出，自动保存被永久关闭，服务器照常运行，没有人察觉。这是当初选冷备份的另一半理由。

配套的 service 与 timer 写全，`/etc/systemd/system/minecraft-backup.service`：

```ini
[Unit]
Description=Minecraft Fabric backup
After=minecraft-fabric.service

[Service]
Type=oneshot
ExecStart=/opt/minecraft/backup-fabric.sh
```

`After=` 不会主动启动主服，作用只在排序。`Persistent=true` 补跑的备份可能恰好落在开机时刻，与主服的启动流程同时运行。不做排序的话，备份脚本可能在主服还处于 activating 状态时判断它没有运行，然后把 socket 停掉。

`/etc/systemd/system/minecraft-backup.timer`：

```ini
[Unit]
Description=Daily Minecraft Fabric backup

[Timer]
OnCalendar=*-*-* 05:00:00
Persistent=true

[Install]
WantedBy=timers.target
```

两个细节。`Persistent=true`：如果机器在计划时刻恰好处于关机或维护状态，下次启动后会补跑错过的那一次，而不是静默跳过。**`OnCalendar` 按服务器自身时区解释**，很多 VPS 默认 UTC。所以本文所有05:00都指**服务器本地时间**，启用前先确认再验证：

```bash
timedatectl                                      # 确认机器时区
systemd-analyze calendar '*-*-* 05:00:00'        # 验证下一次触发的实际时刻
```

要么用 `timedatectl set-timezone` 把机器设到期望的时区，要么保持 UTC、自行换算后写对应时刻，二选一，以 `systemd-analyze` 的输出为准。timer 触发的 service 默认以 root 运行，这正是脚本能执行 `systemctl stop/start`、能写入 root 属主 `backups/` 目录的前提，脚本本身的属主与权限也相应收紧。部署并演练：

```bash
sudo chown root:root /opt/minecraft/backup-fabric.sh
sudo chmod 0750 /opt/minecraft/backup-fabric.sh
sudo systemctl daemon-reload
sudo systemctl enable --now minecraft-backup.timer
sudo systemctl start minecraft-backup.service    # 手动触发一次，验证整个流程
systemctl list-timers minecraft-backup.timer     # 确认下次执行时间
```

手动触发这一步不要省略。建议在此基础上再做一次恢复演练：挑一个备份文件解压到临时目录，用它启动一个测试实例，确认世界数据完好。**没有经过恢复演练的备份，其可靠性是无法确认的**。最后，本机备份只能覆盖误操作场景，无法应对机器本身的故障，因此建议用 rclone 将备份目录同步一份到异地的对象存储。我使用已有的 Cloudflare R2 存储桶，其免费额度为每月 10 GB-month 存储，超出部分按量计费。几十 GB 的备份存量会产生少量费用，但作为异地容灾手段，整体成本仍然较低，配合上面 `find` 的保留策略控制存量即可。

## 5 群峦：重生副服

副服是[群峦：重生（TerraFirma: Rebirth）](https://bbsmc.net/modpack/terrafirma-rebirth) v2.2，基于 1.20.1 Forge 的群峦传说：次世代整合包。不公开，按需启动，使用已有的存档。

动手前先说清两点与主服的原则性差异。其一，**Java 17**，理由见开头的前置判断。这也是坚持在 systemd 单元里写 Java 绝对路径的直接受益场景，两个单元各指各的 Java，互不干扰。其二，**部署用官方服务端包（server pack），不要拿客户端整合包自己改**。客户端包里含光影前置、HUD 这类客户端专用模组，放到服务端会启动崩溃。服务端包已经替你剔除了它们，这正是它存在的意义。

**1. 上传服务端包。** `my-server` 是加固文里在客户端 `~/.ssh/config` 配好的别名，直接复用：

```bash
scp TFCR-Server-2.2.zip my-server:/tmp/
```

**2. 解压归位。**

```bash
sudo apt install unzip
sudo unzip /tmp/TFCR-Server-2.2.zip -d /opt/minecraft/tfcr
sudo chown -R minecraft-tfcr:minecraft-tfcr /opt/minecraft/tfcr
sudo ls /opt/minecraft/tfcr    # 确认 mods/、config/ 等目录直接可见
```

有些压缩包会在内部多套一层顶层目录，如果 `ls` 的结果里只有一个文件夹，把它的内容整体上移一级再继续，否则后面所有路径都对不上。

**3. 读启动脚本，确认 Forge 就位。** 如果包里带 `run.sh`，**先 `cat` 读一遍**。整合包作者可能在脚本里放了额外的安装或参数逻辑，不能假定手工调用与它等价。多数情况下它只是 `java @user_jvm_args.txt @libraries/.../unix_args.txt` 的简单包装，那就按本文后续的等价命令直接调用。如果它确实包含额外逻辑，处理方式反过来：把脚本里的 `java` 换成 Java 17 绝对路径，后面首次启动和 systemd 都执行脚本本身。二者取一，不要没读过脚本就做决定。

如果包里没有预装 Forge（没有 `libraries/` 目录，只有一个 `forge-1.20.1-xx.x.x-installer.jar`），先安装：

```bash
sudo -u minecraft-tfcr sh -c 'cd /opt/minecraft/tfcr && \
    exec /usr/lib/jvm/java-17-openjdk-amd64/bin/java -jar forge-1.20.1-<版本>-installer.jar --installServer'
```

这里有一处与主服的结构性差异：1.17 之后的 Forge 服务端不再是单个 jar，启动参数由 `libraries/` 里的参数文件提供，后面首次启动和 systemd 单元都要引用它的路径。先把实际路径记下来：

```bash
sudo ls /opt/minecraft/tfcr/libraries/net/minecraftforge/forge/
# 本例输出 1.20.1-47.2.6，unix_args.txt 就在这个目录里
```

**4. 检查 JVM 参数。** Forge 的约定是 JVM 参数写在 `user_jvm_args.txt`。**先看内容再动手**，整合包作者往往已经预置了参数，，处理原则与 `run.sh` 一致，作者随包发布，按此测试过的配置默认尊重，**GC 参数原样保留，只改堆大小**。

```
/opt/minecraft/tfcr/user_jvm_args.txt
```

**5. 首次启动与 EULA。** 先跑一次让它生成 `eula.txt` 和 `server.properties` 后退出：

**如果服务端 `eula.txt` 和 `server.properties` 文件完整，可跳过此步骤，直接复制旧存档**

```bash
sudo -u minecraft-tfcr sh -c 'cd /opt/minecraft/tfcr && \
    exec /usr/lib/jvm/java-17-openjdk-amd64/bin/java \
    @user_jvm_args.txt @libraries/net/minecraftforge/forge/1.20.1-47.2.6/unix_args.txt nogui'
sudo -u minecraft-tfcr sed -i 's/eula=false/eula=true/' /opt/minecraft/tfcr/eula.txt
```

**这时先不要做第二次启动**。一是会白白生成一个全新世界，二是配置还没改：主服正占着默认的 25565 端口，此时启动 TFCR 会因端口冲突直接失败。先完成下面两步。

**6. 导入旧存档与名单文件。** 存档来自之前的服务器，把旧服的 `world` 目录和几个名单文件一起传上来：

**记得删除第一次启动生成的world文件**

```bash
scp -r "<旧服目录>/world" my-server:/tmp/tfcr-world
scp "<旧服目录>"/{whitelist.json,ops.json,banned-players.json,banned-ips.json} my-server:/tmp/
sudo mv /tmp/tfcr-world /opt/minecraft/tfcr/world
sudo mv /tmp/{whitelist.json,ops.json,banned-players.json,banned-ips.json} /opt/minecraft/tfcr/
sudo chown -R minecraft-tfcr:minecraft-tfcr /opt/minecraft/tfcr
```

这里直接把世界改名为 `world`，与 `server.properties` 的 `level-name` 默认值对齐。保留原名、改 `level-name` 指向它也完全等价，二选一即可，不要两头都不改。

**7. server.properties，必须在第二次启动之前修改。**

```properties
server-port=25566
online-mode=true
white-list=true
enforce-whitelist=true
level-name=world
```

`server-port` 与主服错开，这是第 5 步提到的端口冲突的解法。`white-list=true` 是副服的准入机制。`enforce-whitelist=true` 让名单变更立即生效，从名单里移除某人时会把已在线的他直接踢出，而不是等他下次登录才拦截。

**8. 第二次启动，验证世界。** 执行第 5 步那条 java 命令，日志里应看到加载已有世界而不是生成新世界，进服确认建筑和进度都在后 `stop`。整合包加载全部模组明显比原版慢，耐心等待 `Done`。如果中途崩溃，crash report 的第一段几乎总会指明原因。用官方服务端包一般不会遇到，遇到了优先怀疑第 2 步的目录层级、第 3 步的 Forge 版本，以及存档与整合包版本是否对应（v2.1 的存档就要配 v2.1 的服务端包）。

**9. systemd 单元。** socket 单元沿用主服的配置，把名称、FIFO 路径与 `SocketUser` 换成 `minecraft-tfcr` 与 `/run/minecraft-tfcr.stdin`。服务单元 `/etc/systemd/system/minecraft-tfcr.service` 如下，与主服的差异在于 Java 17 路径、`@` 参数文件的启动方式、运行用户，以及不做开机自启：

```ini
[Unit]
Description=Minecraft TFCR server
Requires=minecraft-tfcr.socket
After=network.target minecraft-tfcr.socket

[Service]
User=minecraft-tfcr
WorkingDirectory=/opt/minecraft/tfcr
ExecStart=/usr/lib/jvm/java-17-openjdk-amd64/bin/java @user_jvm_args.txt @libraries/net/minecraftforge/forge/1.20.1-47.2.6/unix_args.txt nogui
StandardInput=socket
StandardOutput=journal
StandardError=journal
ExecStop=/bin/sh -c 'if [ -n "$MAINPID" ] && kill -0 "$MAINPID" 2>/dev/null; then printf "stop\n" > /run/minecraft-tfcr.stdin; while kill -0 "$MAINPID" 2>/dev/null; do sleep 1; done; fi'
TimeoutStopSec=180
Restart=no

[Install]
WantedBy=multi-user.target
```

`/etc/systemd/system/minecraft-tfcr.socket`：

```ini
[Unit]
Description=Minecraft TFCR server console FIFO

[Socket]
ListenFIFO=/run/minecraft-tfcr.stdin
SocketMode=0600
SocketUser=minecraft-tfcr
RemoveOnStop=true

[Install]
WantedBy=sockets.target
```

`ExecStop` 与主服相同，发 `stop` 后等待主进程真正退出，原理见主服一节。`TimeoutStopSec` 先给 180，整合包的世界保存比原版慢，副服没有 Ledger，这个值以实际停机日志为准再调。`Restart=no` 也是有意为之：按需启动的服务崩溃后应该由人来检查日志，而不是无人值守地反复拉起。两个单元都**不 enable**。`Requires=` 保证启动服务时 socket 会被自动带起，而不 enable 意味着机器重启后副服不会自动恢复，这正是想要的行为：

```bash
sudo systemctl daemon-reload
sudo systemctl start minecraft-tfcr
sudo systemctl stop minecraft-tfcr
```

**10. 白名单维护。** 名单通过控制台 FIFO 管理，回执看 `journalctl -u minecraft-tfcr`：

```bash
echo "whitelist add <朋友的正版ID>" | sudo tee /run/minecraft-tfcr.stdin
echo "whitelist list" | sudo tee /run/minecraft-tfcr.stdin
```

接入信息（地址加端口 25566）私下发给朋友，不出现在博客上。

**11. 备份。** 不常驻的服务备份更简单：把主服的 `backup-fabric.sh` 复制为 `backup-tfcr.sh`，改动只有开头几个变量（`SVC=minecraft-tfcr`、`SRC=/opt/minecraft/tfcr`、文件名前缀 `fabric` 换 `tfcr`），临时文件、校验、原子改名与失败处理逻辑全部沿用。只改变量在这里成立，依靠的是主服脚本的整目录打包。Forge 整合包会把状态散在 `defaultconfigs/`、`kubejs/`、`scripts/` 这类目录里，还有 `user_jvm_args.txt` 这样的散件，白名单式清单几乎注定会漏，整目录方案则把它们连同日后的改动一并收进来。不挂 timer，每次游玩结束停机后手动执行一次即可。脚本检测到服务已是停止状态时就是纯打包，不会去动服务。rclone 同步的是整个 `backups/` 目录，tfcr 的备份自然也随之同步到异地。除了运行中的实例，还要为这种历史整合包额外归档一份**初始环境**：服务端包原文件与它的 sha256、Java 大版本（17）、Forge 版本号。多年后世界还在而运行环境凑不齐，是老整合包最常见的结局。

## 6 防火墙与域名

加固文里说过，防火墙规则应当跟随服务走，服务部署完成、确认要对外提供访问时再放行对应端口，现在正是这个时候。按照加固文的约定，安全组（Security Group）与 ufw 是相互独立的两道防护，业务端口要在两边同步放行，流量需要同时通过两者才能到达服务：

```bash
sudo ufw allow 25565/tcp comment 'Minecraft Fabric'
sudo ufw allow 25566/tcp comment 'Minecraft TFCR'
sudo ufw status verbose    # 确认规则生效，IPv4/IPv6 各一条
```

安全组侧在云厂商控制台添加相同的两条 TCP 放行。这里用 `allow` 而不是 SSH 那条的 `limit`，因为 Minecraft 客户端断线重连、玩家反复进出都是正常流量模式，内核层连接限速容易误伤。副服端口的取舍需要说明得更准确一些。服务未运行时端口上没有任何监听，不存在 Minecraft 应用层的攻击面。但放行规则本身一直存在，将来若有别的程序意外绑定 25566，它会直接对公网可达。介意这一点的话，可以把该端口的放行与移除做成副服启停流程的一部分。

域名方面，给玩家的地址是 `mc.catwhiteangel.com` 这样的子域，在 Aliyun 添加一条 A 记录即可，博客上公布的只有这一个地址。做一个 SRV 子域，Minecraft 客户端原生支持 `_minecraft._tcp` 的 SRV 解析，玩家可以不填端口号。但不要把它当成访问控制手段，DNS 记录是公开可查询的。

## 7 服务器信息

<div id="mc-card" class="mc-card">正在查询服务器状态…</div>
<style>
.mc-card { display: flex; align-items: center; gap: 14px; padding: 14px 18px;
  border: 1px solid var(--card-border, #e3e8f7); border-radius: 10px; }
.mc-card img { width: 56px; height: 56px; border-radius: 8px; }
.mc-card .mc-line1 { font-weight: 600; }
.mc-card .mc-dot { display: inline-block; width: 9px; height: 9px;
  border-radius: 50%; margin-right: 6px; }
.mc-on  { background: #3fb950; }
.mc-off { background: #d1242f; }
</style>
<script>
(function () {
  const host = 'mc.catwhiteangel.com';
  const el = document.getElementById('mc-card');
  fetch('https://api.mcstatus.io/v2/status/java/' + host)
    .then(r => r.json())
    .then(d => {
      if (!d.online) {
        el.innerHTML = '<span class="mc-dot mc-off"></span>' + host + ' 当前离线';
        return;
      }
      el.innerHTML =
        (d.icon ? '<img src="' + d.icon + '" alt="server icon">' : '') +
        '<div><div class="mc-line1"><span class="mc-dot mc-on"></span>' + host +
        '</div><div>' + d.players.online + ' / ' + d.players.max +
        ' 在线 · ' + d.version.name_clean + '</div>' +
        '<div>' + d.motd.clean + '</div></div>';
    })
    .catch(() => { el.textContent = '状态查询失败（不影响服务器本身）'; });
})();
</script>

## 附录 A：离线旧服存档的玩家数据迁移

旧服如果曾以离线模式（`online-mode=false`）运行，把存档迁移到开启正版验证的新服后，通常会遇到这样的情况：**世界和建筑都完好，但每个玩家进服都变成白板**，出生在世界出生点，背包全空，成就归零。原因是离线模式下玩家数据存放在由玩家名推算的离线 UUID 名下，正版登录使用 Mojang 分配的正版 UUID，服务器找不到对应档案就按新玩家处理。玩家数据不只有 `playerdata/` 一处，成就、统计、FTB 队伍、任务进度、死亡记录都按 UUID 归档，所以迁移必须按 UUID 全局处理，不能只挑个别文件。整个过程在停服状态下进行，动手前先跑一次备份脚本。

**前置：让每个玩家用正版进一次服。** 进服后是白板属于正常现象，什么都不要做，直接退出即可。这一步的目的是让 `usercache.json` 记录下每个玩家「玩家名 → 正版 UUID」的映射，后面的脚本要用到。

**第一步：算出两个 UUID。** 离线 UUID 由玩家名按 `OfflinePlayer:<名字>` 的 MD5 推算（UUIDv3），正版 UUID 从 `usercache.json` 查询：

```bash
NAME=<玩家名>
W=/opt/minecraft/tfcr/world

OFF=$(python3 -c '
import hashlib, uuid, sys
b = bytearray(hashlib.md5(("OfflinePlayer:"+sys.argv[1]).encode()).digest())
b[6] = (b[6] & 0x0F) | 0x30; b[8] = (b[8] & 0x3F) | 0x80
print(uuid.UUID(bytes=bytes(b)))' "$NAME")

NEW=$(sudo python3 -c '
import json, sys
d = json.load(open("/opt/minecraft/tfcr/usercache.json"))
print(next(e["uuid"] for e in d if e["name"].lower() == sys.argv[1].lower()))' "$NAME")

echo "offline=$OFF  online=$NEW"    # 两个都非空再继续
```

**第二步：预览再动手。** 先看两个 UUID 各命中哪些文件，确认形态符合预期。正版 UUID 命中的应该只有刚才白板登录生成的空白档（`playerdata`、`advancements`、`stats`，可能还有 `ftbteams/player`），离线 UUID 命中的是旧档的同类文件，外加只属于它的进度类目录（`ftbquests`、`deaths` 等）：

```bash
sudo find "$W" \( -name "*$NEW*" -o -name "*$OFF*" \) | sort
```

**第三步：删空白档、改名旧档。** 顺序不能反，必须先清掉正版 UUID 名下的空白档，改名时才不会撞车：

```bash
sudo find "$W" -depth -name "*$NEW*" -exec rm -rf {} +

sudo find "$W" -depth -name "*$OFF*" | while read -r p; do
    sudo mv "$p" "${p//$OFF/$NEW}"
done

sudo chown -R minecraft-tfcr:minecraft-tfcr "$W"
```

`-depth` 让 find 先输出深层条目再输出目录本身，这样即使 UUID 出现在目录名里（FTB 系模组会这么做）也能正确改名。`.dat_old` 这类备份副本会被通配符一并匹配，不需要单独处理。

**第四步：文件内容里的 UUID。** 改文件名管不到写在文件内容里的引用，FTB Teams 的队伍归属和任务进度内部都记录着 UUID。这一步只对**纯文本格式**做替换，二进制的 `.dat` 文件绝对不能用 sed 处理：

```bash
sudo grep -rl "$OFF" "$W" --include='*.json' --include='*.snbt' --include='*.toml' \
    | while read -r f; do sudo sed -i "s/$OFF/$NEW/g" "$f"; done
```

还有一种容易漏掉的写法：UUID 在部分文件里以**不带连字符**的形式出现，上面那轮替换覆盖不到，需要补一轮：

```bash
OFFND=${OFF//-/}; NEWND=${NEW//-/}
sudo grep -rl "$OFFND" "$W" --include='*.json' --include='*.snbt' --include='*.toml' \
    | while read -r f; do sudo sed -i "s/$OFFND/$NEWND/g" "$f"; done
```

**第五步：验证。** 每个玩家重复第一到四步（改 `NAME` 即可），全部完成后启动服务器，各自进服核对四样东西：登出时的位置、背包、成就、任务界面的队伍与进度。全部确认无误即迁移完成，此时立即再跑一次备份，把这个干净的状态留档。

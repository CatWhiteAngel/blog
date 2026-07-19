---
title: 从零搭建企业虚拟化平台3——vCenter 与集群：部署 VCSA 与组建集群
hidden: true
date: 2026-06-24 20:49:00
categories: [Virtualization, vSphere Lab]
tags: [VMware, vCenter, vSphere]
description: 部署 vCenter Server（VCSA）并组建数据中心与集群，把三台嵌套 ESXi 收归统一控制面；重点解决 vSAN 尚未建立时 VCSA 落在哪块存储上的自举问题，以及部署对 DNS 正反向解析与时间同步的硬性依赖。
---

# 从零搭建企业虚拟化平台3——vCenter 与集群：部署 VCSA 与组建集群

{% note info %}
**📚 从零搭建企业虚拟化平台 · 全系列导航**

- [平台0 · 序章：缘起与全局规划](https://www.catwhiteangel.com/enterprise-vsphere-lab-00-prologue/)
- [平台1 · 环境：OPNsense 与网段搭建](https://www.catwhiteangel.com/enterprise-vsphere-lab-01-environment/)
- [平台2 · 计算：三台嵌套 ESXi](https://www.catwhiteangel.com/enterprise-vsphere-lab-02-esxi/)
- **平台3 · vCenter：部署与建集群　← 本篇**
- [平台4 · 网络：vDS 与端口组](https://www.catwhiteangel.com/enterprise-vsphere-lab-04-network/)
- [平台5 · 存储：vSAN 全闪](https://www.catwhiteangel.com/enterprise-vsphere-lab-05-storage/)
- [平台6 · 高可用：HA 与 DRS](https://www.catwhiteangel.com/enterprise-vsphere-lab-06-ha-drs/)
- [平台7 · 身份：AD 域控与 DNS](https://www.catwhiteangel.com/enterprise-vsphere-lab-07-ad-dns/)
- [平台8 · 收尾：时间同步、vLCM 与全系列回顾](https://www.catwhiteangel.com/enterprise-vsphere-lab-08-ntp-wrapup/)
{% endnote %}

上一篇把三台嵌套 ESXi 立了起来：评估模式、正反向解析、时间对齐、二层安全策略也提前放开。但此刻它们还是三台**各自为政**的主机——Host Client 一次只能管一台，集群、HA、DRS、vMotion、vSAN 这些本系列真正要的能力，一个都还谈不上。

这一篇就来补上控制面：部署 vCenter Server（以 VCSA 形式），把三台主机收编进一个数据中心与集群之下。这里有个前三篇没正面处理、却绕不过去的坎——**VCSA 要落在哪块存储上**：三台主机现在只有 32 GB 启动盘，而 vSAN 又排在更后面，于是出现一个典型的「先有鸡还是先有蛋」。本篇会把它讲透。

<!-- more -->

## 1 先认识 vCenter：为什么集群非它不可

把三台 ESXi 串成一个有高可用、能调度的集群，靠的不是主机之间「自发组队」，而是一个统一的控制面——vCenter Server。它持有整套环境的清单（inventory）、单点登录（SSO）、权限、任务与告警，也是 HA、DRS、vMotion、vSAN 这些集群级特性的**唯一**配置入口。没有它，三台主机就只是三台孤立的 hypervisor。这也正是上一篇坚持用评估模式、而非免费版的根本原因：免费版接不进 vCenter。

本篇落地三件事：部署 VCSA、创建一个数据中心（Datacenter）对象、创建一个集群（Cluster）对象并把三台主机纳入。集群的网络进阶（分布式交换机 vDS）、存储（vSAN）、以及 HA/DRS 的实际调优，分别留到后面第五、六、七篇——本篇先把「骨架」搭起来：数据中心与集群对象先建好，HA、DRS、vSAN 等功能开关暂不启用，等后续对应篇章再逐一打开。

{% note info %}
**vCenter 与 ESXi 的分工，以及一个绕不开的自举（bootstrap）事实。** ESXi 是真正跑虚拟机的 hypervisor；vCenter 是管理这些 hypervisor 的控制面，它本身也是一台虚拟机（VMware 把它打包成一个基于 Photon OS 的设备，称作 vCenter Server Appliance，VCSA）。在我们这套单机全虚拟环境里，VCSA 这台 VM 将运行在 `yx-esxi01` 上——也就是说，它运行在自己即将纳管的那台主机之上。这在生产里要尽量规避，但在实验室里是常态，vCenter 完全可以纳管承载着它自己的那台主机，后文会专门点出这一点。
{% endnote %}

## 2 部署前扫清三个前提：DNS、时间、存储

VCSA 的安装器对环境是「挑食」的，前提没备齐，它会在中途停下，且报错往往指不到根因。动手前先把下面三件事确认到位。

**其一，正反向 DNS。** 这是 VCSA 安装失败最常见的单一原因。安装器会校验 vCenter 自身的 FQDN 能否被正向（名字 → 地址）与反向（地址 → 名字）同时解析，缺一不可。`yx-vc01`（`10.0.10.20`）这条 A + PTR 记录，第二篇的前置工作里已经在 OPNsense 的 Unbound 上建好了。现在在宿主上复核一遍再开工：

```powershell
nslookup yx-vc01.corp.yanxing.internal 10.0.10.1
nslookup 10.0.10.20 10.0.10.1
```

前者应只返回 `10.0.10.20`，后者应解析回 `yx-vc01.corp.yanxing.internal`。

{% note warning %}
若正向能解析、反向却不行（或反过来），安装器会在「配置网络」一步拒绝继续，提示 FQDN 与 IP 对不上之类的话——别去怀疑 IP 填错了，回到 OPNsense 的 `Services → Unbound DNS → Overrides`，确认 `yx-vc01` 那条记录勾了 `Add PTR record`。这是「配好了却不通」类故障，正向单测往往会骗过你。
{% endnote %}

**其二，时间。** VCSA 与承载它的主机时钟必须一致，否则证书与服务启动都会出问题。`yx-esxi01` 的 NTP 在上一篇已指向 `10.0.10.1` 并同步；VCSA 自己稍后也会在安装阶段配上同一个 NTP 源。这一步无需额外动作，确认 esxi01 的时间正确即可。

**其三，存储——本篇真正要解决的坎。** VCSA 即便是最小的 `Tiny` 规格，标称存储也要约 579 GB；而三台 ESXi 现在每台只有一块 32 GB 启动盘，装完系统分区后几乎不剩可用的 datastore，根本放不下 VCSA。本该承载它的共享存储 vSAN，又排在第六篇——在 vCenter 之后。这就是单机全虚拟环境特有的自举难题：**vSAN 要靠 vCenter 来配，vCenter 又要先有地方落脚。**

解法是先给 `yx-esxi01` 单独加一块**精简置备（thin）**的本地盘，起一个临时本地 datastore 把 VCSA 装上去；等第六篇 vSAN 建好，再用 Storage vMotion 把 VCSA 无中断迁到 vSAN 上、回收这块临时盘。

具体操作：在 Workstation 里给 `yx-esxi01` 这台虚拟机**添加一块硬盘**，容量 `600 GB`，模式选**精简置备 / 不预分配**（即不勾「立即分配所有磁盘空间」）。精简置备意味着这 600 GB 只是上限，宿主 NVMe 上的实际占用会随写入逐步增长，初期只有几十 GB，不会真吃掉 600 GB。

加盘后开机进 esxi01 的 Host Client，`Storage` → `Datastores` → `New datastore` → `Create new VMFS datastore`，选中刚加的那块约 600 GB 的设备，命名 `esxi01-local`，文件系统用默认的 `VMFS 6`、占满整盘，完成。

![](https://img.gulugulublog.com/posts/enterprise-vsphere-lab-03-vcenter/20260625005841853.png)

{% note warning %}
这块临时盘只加给 `yx-esxi01`——只有它要承载 VCSA。`esxi02`、`esxi03` 暂时不需要额外存储，等第六篇做 vSAN 时再统一给三台加缓存盘与容量盘。本篇不要去动另外两台的磁盘。
{% endnote %}

{% note primary %}
**生产环境对照**：真实环境里 vCenter 从第一天起就落在共享存储上，而且是**分离部署**的——这套分离，正是我们这台寄居在 `yx-esxi01` 本地盘上的 VCSA 所欠缺的。

通常的做法是单独划出一个**管理集群（management cluster）**，专门承载 vCenter、NSX Manager、监控与备份等控制面组件，与跑业务负载的**工作负载集群（workload cluster）**在主机、存储、网络上都分开。vCenter 不寄居在它所纳管的工作负载主机里，故障域彼此隔离。

控制面自身的高可用分两层。其一，VCSA 放在管理集群的**共享存储（SAN / vSAN）**上，承载它的主机一旦宕机，**vSphere HA** 会在管理集群的另一台主机上自动把它重启起来——这是本地盘做不到的（主机没了，盘上的 VCSA 也一起没了）。其二，在这种「重启级」保护之上，还可启用 **vCenter HA（VCHA）**：把 VCSA 做成 `Active` / `Passive` / `Witness` 三节点，分布在不同主机（理想情况下也用不同存储），经一条专用 VCHA 网络同步状态；主节点故障时被动节点接管，提供 vCenter 服务层面的更快故障切换，而非仅靠整机重启。

这里要点破一个看似矛盾的地方：管理集群的 vCenter，管的就是它自己所在的那个集群——这完全正常、且受支持。不构成死锁的原因在于，**vSphere HA 的故障切换是各 ESXi 主机上的 FDM（Fault Domain Manager）代理自己执行的，并不依赖 vCenter**：vCenter 只负责把 HA 配好，配完之后即便它自己宕了，承载它的主机一旦挂掉，管理集群里另一台主机也照样能把 VCSA 重启起来——救它的是主机，不是它自己。（相较之下，DRS 的自动均衡确实要 vCenter 在线，但 HA 重启不要；所以 vCenter 宕机的窗口里，自我保护成立、自我调度暂停，够用。）也正因如此，VCF 里真正「自管」的只有最底层的管理域 vCenter；各工作负载域的 vCenter 则自己在管理域、管的是别处的工作负载集群。

还有一条贯穿性原则：**刻意避免循环依赖**——不让 vCenter 的恢复路径依赖它自己管理的那套集群、存储与身份（这与第一篇域控那段「AD 挂掉 → 登不进 vCenter → 修不了 AD」是同一类问题）。正因如此，即便在 VMware Cloud Foundation 这类自动化部署里，引导顺序也是先由 Cloud Builder 立起**管理域（management domain）**——第一套集群 + vCenter + NSX 落在管理域的共享存储上，之后再创建工作负载域。换言之，生产里同样有「引导」，但引导目标是专用管理集群的共享存储，而非某台工作负载主机的本地盘。

我们这套单机环境把以上全部折叠进一台笔记本：VCSA 寄居在 `yx-esxi01` 的本地盘、与它纳管的「集群」是同一批主机、也没有第二个节点兜底——这正是实验室最大的单点。其中哪些可由 vSphere HA 部分补救、哪些是单机注定无解的，留到第七篇讲 HA 时再回看。
{% endnote %}

## 3 部署 VCSA（两阶段安装）

VCSA 的安装介质与上一篇 ESXi 同源——在 Broadcom 支持门户下载 **vCenter Server** 的安装 ISO（文件名形如 `VMware-VCSA-all-8.0U3*-*.iso`），同样需要你账号下的评估 / 个人实验室授权权益。vCenter 部署完成后会自动进入 60 天评估模式，本篇不贴任何 license。

**本篇使用VMware-VCSA-all-8.0.3-25413364.iso**

把 ISO 在 Windows 宿主上装载（双击挂为虚拟光驱），运行其中的 `vcsa-ui-installer\win32\installer.exe`，选 `Install`。安装分两个阶段：先把设备这台 VM 部署出来，再对它做初始化配置。

**Stage 1：Deploy（部署设备）**

逐页填写，关键项如下（其余保持默认）：

- `End User License Agreement`：接受。
- `vCenter Server deployment target`：填**承载主机**，即 `yx-esxi01`——`ESXi host or vCenter Server name` 填 `10.0.10.11`，`HTTPS port` 默认 `443`，`User name` 填 `root`、`Password` 填该主机 root 密码。出现证书指纹警告点 `Yes` 接受。
- `Set up vCenter Server VM`：`VM name` 填 `yx-vc01`，并为设备本身设置 `root` 密码（这是 VCSA 这台设备的操作系统密码，与 SSO 管理员密码是两回事）。
- `Select deployment size`：`Deployment size` 选 `Tiny`，`Storage size` 选 `Default`。
- `Select datastore`：选刚建的 `esxi01-local`，**勾上 `Enable Thin Disk Mode`**——这样 VCSA 的虚拟磁盘按精简置备，配合 Workstation 那块精简盘，实际占用降到最低。
- `Configure network settings`：
  - `Network`：选主机上的 `VM Network`（vSwitch0 上的默认 VM 端口组，位于管理网）。
  - `IP version`：`IPv4`；`IP assignment`：`static`。
  - `FQDN`：`yx-vc01.corp.yanxing.internal`
  - `IP address`：`10.0.10.20`
  - `Subnet mask or prefix length`：`24`
  - `Default gateway`：`10.0.10.1`
  - `DNS servers`：`10.0.10.1`
- `Ready to complete stage 1`：核对无误后 `Finish`，安装器开始把设备部署到 `yx-esxi01`。

![](https://img.gulugulublog.com/posts/enterprise-vsphere-lab-03-vcenter/20260625010459204.png)

{% note info %}
**这是第一台「内层 VM」。** VCSA 的网卡接在 `yx-esxi01` 的 `VM Network` 上，流量走 vSwitch0 → `vmnic0` → VMnet2 → 管理网。它带着自己的 MAC（不同于 vmnic0），正是上一篇我们提前把 vSwitch0 的二层安全策略放开所要照顾的那类流量。所以这台设备一部署出来，网络就该是通的。
{% endnote %}

**Stage 2：Set up（初始化配置）**

Stage 1 完成后接着进入 Stage 2（若中途关了窗口，浏览器访问 `https://10.0.10.20:5480` 也能续上）：

- `vCenter Server configuration`：
  - `Time synchronization mode`：选 `Synchronize time with NTP servers`，`NTP servers` 填 `10.0.10.1`。
- `SSH access`：选 `Activated`。一来实验室排错方便；二来它也是启用 vCenter HA（VCHA）的前提——界面会就此给出提示，正呼应 §2 生产环境对照里讲的 VCHA。本系列不配 VCHA，开着也无妨。
- `SSO configuration`：选 `Create a new Single Sign-On domain`：
  - `Single Sign-On domain name`：`vsphere.local`
  - `Single Sign-On user name`：`administrator`（即登录账号 `administrator@vsphere.local`）
  - 设置 SSO 管理员密码。
- `Configure CEIP`：客户体验改进计划，按需勾选。
- `Ready to complete`：`Finish`，设备开始初始化服务，耐心等其跑完。

![](https://img.gulugulublog.com/posts/enterprise-vsphere-lab-03-vcenter/20260625011653762.png)

完成后，优先用浏览器访问 `https://yx-vc01.corp.yanxing.internal/ui`，用 `administrator@vsphere.local` 登录 vSphere Client；`https://10.0.10.20/ui` 可作为 DNS 排错时的临时访问方式。养成用 FQDN 管 vCenter 的习惯，与前面强调的正反向解析、证书是一脉相承的。

![](https://img.gulugulublog.com/posts/enterprise-vsphere-lab-03-vcenter/20260625012644500.png)

{% note info %}
**SSO 域为什么用 `vsphere.local`、而不是 AD 的 `corp.yanxing.internal`。** vCenter 的 SSO 域是它自己的内置身份源，独立于 Windows 域。把两者取成同一个名字是 VMware 明确不建议的做法，会埋下解析与信任上的混淆。正确的关系是：SSO 域保持独立的 `vsphere.local`，而 AD（`corp.yanxing.internal`）将来作为**外部身份源**接入 vCenter——那一步留到第八篇域控就位后再做。本篇先用 SSO 本地管理员把平台跑起来。
{% endnote %}

{% note warning %}
两阶段里最容易卡的仍是 Stage 1 的网络页：FQDN 必须能被正反向解析（见 §2），否则 `Finish` 之后会在部署或初始化阶段失败。其次是存储——若没勾 `Enable Thin Disk Mode`、或 datastore 容量不足 579 GB，安装器会直接拦下。这两点确认好，整个流程基本一次过。
{% endnote %}

## 4 组建数据中心与集群

登进 vSphere Client，此刻清单里还空着，只有一个 vCenter 根节点。按「数据中心 → 集群 → 加入主机」的顺序搭起来。

**创建数据中心。** 右键 vCenter 根节点 → `New Datacenter`，命名 `YX-Datacenter`。数据中心是清单里的顶层容器，把同属一处的主机、存储、网络归在一起。

**创建集群。** 右键 `YX-Datacenter` → `New Cluster`，命名 `YX-Cluster01`。vSphere 8 在这一步会列出几个开关：`vSphere HA`、`vSphere DRS`、`vSAN`，以及 `Manage all hosts in the cluster with a single image`（即 vLCM 镜像式生命周期管理）。**本篇全部保持关闭**：

- HA、DRS 留到第七篇专门配置与演示故障切换。
- vSAN 留到第六篇构建。
- 单一镜像（`Manage all hosts in the cluster with a single image`，即 vLCM image）这一项也先不开。需说明的是，它其实是 vSphere 8 新建集群的**默认**选项，也是 vSphere 9 起**唯一**的生命周期管理模式（旧的 baseline / VUM 已被移除）——本系列并非否定它，而是刻意延后到收尾篇统一讲：届时把集群转换为单一镜像、设定期望 ESXi 版本与组件，并演示合规检查与滚动修复。之所以延后，是因为滚动修复要想做得接近生产形态，至少需要共享存储、vMotion 网络与足够的主机资源；DRS 就位后，疏散与放置也更接近真实环境。当前 VCSA 还寄居在 `yx-esxi01` 的本地 datastore 上，若此时直接演示 remediation，既不优雅，也容易把生命周期管理与自举临时状态混在一起。


集群此刻只是个空壳，开关空着不影响后续逐一启用。

{% note primary %}
**生产环境对照**：`Manage all hosts with a single image` 在生产里恰恰是推荐做法——vLCM 以一份「期望镜像」（ESXi 版本 + 驱动 + 固件基线）统一约束集群内所有主机，杜绝版本漂移，升级也以集群为单位滚动进行。这正是上一篇提到的「裸金属用 vLCM 管理生命周期」，而到 vSphere 9 它已是唯一的生命周期模式。我们这里只是延后、并非跳过：收尾篇会把集群转过去并演示合规与滚动修复。需诚实指出的是，期望镜像中最具企业含金量的**固件 / 驱动 add-on** 依赖硬件厂商的 Hardware Support Manager 插件，嵌套虚拟主机没有物理硬件、也就没有这一层，届时只能演示 ESXi 版本 + 组件 + 合规 + 修复这半套。
{% endnote %}

**把三台主机加入集群。** 右键 `YX-Cluster01` → `Add Hosts`。在 `New hosts` 里逐台填入 FQDN 与凭据（也可一次性填三台）：

| Host | 凭据 |
| --- | --- |
| `yx-esxi01.corp.yanxing.internal` | `root` / 主机密码 |
| `yx-esxi02.corp.yanxing.internal` | `root` / 主机密码 |
| `yx-esxi03.corp.yanxing.internal` | `root` / 主机密码 |

下一步会列出每台主机的证书指纹（`Security Alert`），确认无误后接受。再下一步 `Host Summary` 核对三台型号、版本一致，`Finish`。

![](https://img.gulugulublog.com/posts/enterprise-vsphere-lab-03-vcenter/20260625013016766.png)

{% note info %}
`Host Summary` 页若对 `yx-esxi01` 标黄、提示 `This host has 1 powered on VMs`，这不是错误：那台开机的 VM 就是 VCSA（`yx-vc01`）。展开可见 `Powered On VMs = yx-vc01`、`Datastores = esxi01-local`、`Networks = VM Network`，与 §3 的部署一致；`Current vCenter` 显示 `-`，表示它尚未被任何 vCenter 纳管、正要被本台接管。直接继续即可——这正是 §1 所说自举的具象呈现：把承载 vCenter 的那台主机一并纳管。
{% endnote %}

{% note info %}
**可以放心地把 `yx-esxi01` 加进来，哪怕 VCSA 正跑在它上面。** 这正是 §1 说的自举：vCenter 纳管承载它自己的那台主机，完全成立。加入过程中 vCenter 会接管 esxi01 的管理，VCSA 自身的网络与运行不受影响。三台主机的评估授权也会一并归拢到 vCenter 的清单里。
{% endnote %}

![](https://img.gulugulublog.com/posts/enterprise-vsphere-lab-03-vcenter/20260625013353810.png)

主机会逐台加入集群，过程中可能出现重新连接、证书接受、vCenter Agent（vpxa / FDM）安装等任务，属正常。本次实验中，通过 `Add Hosts` 向导加入后，`yx-esxi02`、`yx-esxi03` 显示为 `(Maintenance Mode)`，而承载着 VCSA 的 `yx-esxi01` 因其上有开机 VM，未被置入维护模式。加入完成后，分别右键这两台 → `Maintenance Mode` → `Exit Maintenance Mode` 退出即可；此时其上无 VM、也未启用 HA / DRS / vSAN，退出无副作用。

若你的界面中主机加入后已经是 `Connected` 且不带 `(Maintenance Mode)`，则无需执行退出维护模式这一步。


## 5 验证与检查点

三台主机入列后，逐项验收：

{% note success %}
1. **控制面可达**：`https://10.0.10.20/ui` 能用 `administrator@vsphere.local` 登入 vSphere Client。
2. **三台主机在列且健康**：`YX-Cluster01` 下三台主机状态均为 `Connected`、无红色告警（黄色的「主机未配置 vMotion / 无共享存储」之类提示属正常，后续篇章会消除）。
3. **授权为评估模式**：`Administration` → `Licensing` 中，vCenter 与三台主机均为 `Evaluation Mode`（剩余约 60 天）。
4. **时间一致**：三台主机与 VCSA 的时间均同步到 `10.0.10.1`，集群内无时钟偏差告警。
5. **VCSA 落位正确**：VCSA 这台 VM 位于 `yx-esxi01` 的 `esxi01-local` datastore 上，开机正常。
{% endnote %}

![](https://img.gulugulublog.com/posts/enterprise-vsphere-lab-03-vcenter/20260625015317816.png)


{% note info %}
`yx-esxi02`、`yx-esxi03` 的 `Summary` 页带黄叹号、提示 `No datastores have been configured`，这是预期的，与本篇的存储设计自洽：§2 只给 `yx-esxi01` 加了本地盘 `esxi01-local` 承载 VCSA，另两台的缓存盘与容量盘**有意留到第六篇做 vSAN 时再加**，故它们此刻没有任何 datastore。`yx-esxi01` 因有 `esxi01-local` 不标此项。等第六篇 vSAN 就绪、三台都有共享 datastore，这条会自动消失。
{% endnote %}

{% note info %}
`Monitor → Skyline Health` 可能会出现以下两条警告：

- **`Could not execute Online health checks`（`Online health checks execution`）——「还没数据」，会自愈。** vCenter 新部署或重启后系统里尚无健康数据，分析服务每约 90 分钟才采集一次，所以短时间内报这条属预期行为（参见 Broadcom KB 414428）。点 `RETEST` 触发一次重测、或等约 90 分钟自动转为 `healthy` 即可。

- **`Customer experience improvement program (CEIP)` / `Online health connectivity`——取决于是否启用 CEIP 与在线检查** 在线健康检查依赖 CEIP 且要能联网比对；本系列是内网环境、Stage 2 又没启用 CEIP，这条不会自己消。按内网取向把它 `Silence` 即可，或开启 CEIP 让它消解——两种都行，对实验功能均无影响。顺带一提：管理网此刻是放任出站的（能直连互联网，所以 CEIP 一开就能用），第五篇会把它收敛为「受控出站（仅放管理面必需的外部目标）+ 拒绝外部主动入站」，详见那篇的管理网隔离一节。
{% endnote %}

收尾照例拍快照，但 vCenter 在这件事上有讲究：vSphere 集群的状态是 vCenter 与各主机协同维护的，**单独**给某一台 Workstation 虚拟机回退快照、而其余不动，容易让 vCenter 清单与主机实际状态对不上。实验室里稳妥的做法是——需要为这一阶段留底时，把承载 VCSA 的 `yx-esxi01` 连同 `esxi02`、`esxi03` 一起、在**干净关机**后再各拍一张快照（命名如 `cluster-formed`），尽量作为一组一起回退，而不是只回退其中一台。

{% note danger %}
不要在 vCenter 正常运行、且集群存在的状态下，习惯性地只对 `yx-esxi01` 单独回退快照。VCSA 与主机之间有数据库状态在同步，单点回退可能造成清单错乱、主机显示为 `Disconnected` 或证书不匹配，排起来很费劲。要回退就整组回退，或在关键变更前对整组拍照。
{% endnote %}

## 结语

到这里，砚行物流的平台第一次有了「集中控制面」：vCenter 已就位，`YX-Datacenter` / `YX-Cluster01` 成形，三台主机收编入列。前几篇在 DNS、时间、二层安全策略、以及本篇这块临时本地盘上花的功夫，到此兑现成了一个能登、能管、可继续向上叠功能的集群。

下一篇进入**网络进阶**：把主机网络从各自的标准交换机（vSS）迁移到一台横跨集群的分布式交换机（vDS），并在那根一直挂着没用的中继干道（`vmnic1` / VMnet3）上正式划出 VLAN——上一篇预留的第二块网卡，终于要上场了。

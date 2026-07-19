---
title: 从零搭建企业虚拟化平台5——存储：vSAN 构建与外置 iSCSI/NFS 对照
hidden: true
date: 2026-06-25 12:40:00
categories: [Virtualization, vSphere Lab]
tags: [VMware, vSAN, Storage]
description: 用三台主机本地盘构建 vSAN 全闪共享存储，将 VCSA 通过 Storage vMotion 迁入 vSAN 并回收临时本地盘，闭合部署自举；另以 TrueNAS 提供 iSCSI/NFS 外置存储对照，比较超融合与传统外置两条路线的取舍。
---

# 从零搭建企业虚拟化平台5——存储：vSAN 构建与外置 iSCSI/NFS 对照

{% note info %}
**📚 从零搭建企业虚拟化平台 · 全系列导航**

- [平台0 · 序章：缘起与全局规划](https://www.catwhiteangel.com/enterprise-vsphere-lab-00-prologue/)
- [平台1 · 环境：OPNsense 与网段搭建](https://www.catwhiteangel.com/enterprise-vsphere-lab-01-environment/)
- [平台2 · 计算：三台嵌套 ESXi](https://www.catwhiteangel.com/enterprise-vsphere-lab-02-esxi/)
- [平台3 · vCenter：部署与建集群](https://www.catwhiteangel.com/enterprise-vsphere-lab-03-vcenter/)
- [平台4 · 网络：vDS 与端口组](https://www.catwhiteangel.com/enterprise-vsphere-lab-04-network/)
- **平台5 · 存储：vSAN 全闪　← 本篇**
- [平台6 · 高可用：HA 与 DRS](https://www.catwhiteangel.com/enterprise-vsphere-lab-06-ha-drs/)
- [平台7 · 身份：AD 域控与 DNS](https://www.catwhiteangel.com/enterprise-vsphere-lab-07-ad-dns/)
- [平台8 · 收尾：时间同步、vLCM 与全系列回顾](https://www.catwhiteangel.com/enterprise-vsphere-lab-08-ntp-wrapup/)
{% endnote %}

到上一篇为止，集群的网络已经成形，但存储还停在一个尴尬的临时状态：vCenter 那台 VCSA 还寄居在 `yx-esxi01` 的本地盘 `esxi01-local` 上，`esxi02`/`esxi03` 则压根没有任何 datastore——`Summary` 页那个 `No datastores have been configured` 的黄叹号一直挂着。集群想往上叠 HA、DRS、vMotion，第一道坎都是同一个：**得有一块三台主机都能访问的共享存储**。

这一篇就把这块共享存储立起来——不靠外置 SAN，而是用三台主机自己的本地盘聚成 vSAN；建好后顺手把还寄居在临时本地盘上的 VCSA 用 Storage vMotion 迁上 vSAN、回收那块 600 GB 临时盘，闭合上一篇 vCenter 留下的自举（bootstrap）。最后用一台 TrueNAS 做一节外置 iSCSI/NFS 的轻量对照，把「超融合」与「传统外置存储」两条路摆在一起看。

<!-- more -->

## 1 为什么是 vSAN：把本地盘聚成共享存储

集群要的共享存储，传统答案是另设一台外置存储（SAN/NAS），主机通过 iSCSI/FC/NFS 去挂。vSAN（VMware 的超融合存储，Hyper-Converged Infrastructure，HCI）换了个思路：**把每台 ESXi 主机自己的本地盘聚合成一块横跨集群的分布式数据存储**（`vsanDatastore`），不需要单独的存储设备。计算与存储跑在同一批主机上，这正是「超融合」的含义。

这也正好闭合上一篇的自举：vSAN 要 vCenter 来配，而 VCSA 先前只能临时落在 `esxi01-local`；现在 vCenter 已就位，我们把 vSAN 建起来，再把 VCSA 迁到 vSAN 这块有冗余的共享存储上，临时盘随之回收。

vSAN 的 OSA（原始存储架构，Original Storage Architecture）是这样组织磁盘的：每台主机贡献一个**磁盘组（disk group）= 1 块缓存盘（cache，必须是闪存）+ 1～7 块容量盘（capacity）**；vSAN 把各主机的磁盘组汇成一块 `vsanDatastore`；虚拟机的数据以对象（object）形式、按一条**存储策略**（含「允许的故障数」FTT）分布到不同主机上，从而获得冗余。

{% note info %}
**OSA 还是 ESA：本系列为什么走 OSA。** vSAN 8 引入了新的 **ESA（高速存储架构，Express Storage Architecture）**：单层、全 NVMe、无缓存/容量之分，自 vSphere 8 Update 2 起与 OSA 功能对等、性能高 2～5 倍。它在 **RAID-5 / Auto-Policy 这类「数据+校验」布局**下，FTT=1 可以在 3 台主机上实现，且不再需要 OSA RAID-1 那种专门的见证（witness）组件——**对满足硬件条件的全新集群，vSAN 8/9 都推荐优先用 ESA**。但 ESA 对硬件是硬门槛：要 NVMe ReadyNode（设备 ≥1.6 TB、TLC、1 DWPD 以上、不支持 SAS/SATA，网络至少 10GbE 起步，但生产现实通常按 25GbE 或更高规划，具体以 ESA ReadyNode profile / Hardware Guidance 为准），这些我们的嵌套环境根本满足不了。所以本系列走 **OSA**，等以后有条件再单独写 ESA。

要澄清一点：**OSA 并没有被弃用**（vSphere/VCF 9 仍完整保留），被弃用的只是 OSA 的**混合（hybrid）配置**——即「闪存缓存 + 机械容量」那种老形态。我们用的是**全闪 OSA**（缓存与容量都按闪存对待），属当前仍受支持的形态。
{% endnote %}

{% note primary %}
**生产环境对照**：新建集群在生产里如今首选 ESA（性能、成本、TCO 都更优），OSA 主要留给既有硬件的扩容（brownfield）或满足不了 ESA 硬件门槛的场景。无论 OSA 还是 ESA，vSAN 标准集群**最少 3 台主机**，生产**推荐 4 台**——多一台，FTT=1 下某台彻底故障后集群才有地方自动重建副本，而不是只能「撑着」。我们这套正好踩在 3 台的下限上，够演示、但没有重建余量。
{% endnote %}

## 2 OSA 的磁盘画像：给每台主机加盘，并把盘标记为闪存

OSA 每台主机要有缓存盘和容量盘，而三台主机现在只有启动盘。先在 Workstation 里给 `yx-esxi01`/`esxi02`/`esxi03` **每台各加两块精简置备（thin）虚拟盘**：

- 一块约 `50 GB` 作缓存盘；
- 一块约 `150 GB` 作容量盘。

精简置备意味着这些只是上限，宿主 NVMe 上的实际占用随写入增长，初期很小。`yx-esxi01` 上原有的 `esxi01-local`（600 GB，承载 VCSA）暂时保留，等 §5 迁走 VCSA 再回收；本步只是新增 vSAN 用盘，别动 `esxi01-local`。

{% note warning %}
**给 `yx-esxi01` 留足内存——这是本篇一个隐蔽却关键的前提。** vSAN 启用时要在每块盘上初始化它的底层存储格式（LSOM），这一步要吃内存；而 `yx-esxi01` 比另两台多扛着一台 VCSA。本实验里 esxi01 原来的 `20 GB`，在「VCSA + vSAN」双重压力下不够用，直接导致它的磁盘组建不出来（报 `Unable to create LSOM file system`，详见 §4 排障）。**动手做 vSAN 前，先在 Workstation 把 `yx-esxi01` 的内存抬到 `30 GB` 左右**；`esxi02`/`esxi03` 不跑 VCSA，保持 `12 GB` 即可。

不过要清醒一点：在 64 GB 宿主上，`30 + 12 + 12` 再加 OPNsense（~2 GB）与 Windows + Workstation 自身（~8–10 GB）已经贴边。这属 vSAN **初始化阶段的临时高压状态**——此时别同时再开 TrueNAS、跳板机、测试 VM、域控等后续节点；必要时可临时把 `esxi02`/`esxi03` 压到 `10 GB`，优先保证承载 VCSA 的 `yx-esxi01` 有足够空闲内存。vSAN 建好并稳定后，再按后续实验的实际负载重新分配。
{% endnote %}

加盘后开机，进每台主机。这里有 OSA 嵌套**最经典的一个坑**：

{% note warning %}
**ESXi 会把 Workstation 的虚拟盘识别成机械盘（HDD），而 vSAN OSA 的缓存层必须是闪存——这是嵌套的正常现象，不是故障。** 解决办法是手动把这两块新盘**标记为闪存**：vSphere Client → 选中主机 → `Configure` → `Storage` → `Storage Devices` → 勾选那块设备 → 点 `Mark as Flash Disk`（ESXi Host Client 里则是 `Storage` → `Devices` → 选中 → `Mark as flash`）。三台主机的两块新盘都要标记。

为什么两块都标记：只把缓存标记为闪存、容量留作 HDD，得到的是已被弃用的**混合 OSA**；两块都按闪存，才是当前受支持的**全闪 OSA**。标记完，它们在设备列表里的 `Drive Type` 会从 `HDD` 变成 `Flash`。
{% endnote %}

![](https://img.gulugulublog.com/posts/enterprise-vsphere-lab-05-storage/20260625171229969.png)

{% note primary %}
**生产环境对照**：真实主机用的是经认证的 SSD/NVMe，ESXi 会正确识别为闪存，根本不需要「标记为闪存」这一步——它纯粹是嵌套虚拟盘的产物。而 ESA 走得更远：全 NVMe、单层，连「缓存盘 / 容量盘」这种分层都没有了。
{% endnote %}

## 3 vSAN 网络：给每台主机建 vSAN VMkernel

vSAN 主机之间的数据同步走专用网络。上一篇已在 `YX-vDS01` 上建好 `YX-vSAN`（VLAN 30）端口组，这一步给三台主机各建一个启用 vSAN 服务的 VMkernel 适配器接上去。

逐台：主机 → `Configure` → `VMkernel adapters` → `Add Networking` → `VMkernel Network Adapter` → `Select an existing network` 选 `YX-vSAN` → 在 `Enabled services` 勾选 **`vSAN`** → `IPv4 settings` 用 static，按下表填址：

| 主机 | vSAN VMkernel IP | 掩码 | 网关 |
| --- | --- | --- | --- |
| `yx-esxi01` | `10.0.30.11` | `255.255.255.0` | （无） |
| `yx-esxi02` | `10.0.30.12` | `255.255.255.0` | （无） |
| `yx-esxi03` | `10.0.30.13` | `255.255.255.0` | （无） |

`10.0.30.0/24` 是第一篇定的**无网关、不路由的纯二层专用段**——vSAN 流量只在 VLAN 30 内东西向流动，不出网、也不跨段，所以**不填网关**。MTU 保持默认 `1500`。

![](https://img.gulugulublog.com/posts/enterprise-vsphere-lab-05-storage/20260625171428183.png)

{% note info %}
**这个 vSAN vmk 是普通单 MAC 适配器，所以 `YX-vSAN` 端口组保持上一篇的默认 `Reject` 安全策略即可、无需放开**——正好印证上一篇 §5 的判断：只有「一个 VM 代表多个 MAC」才需要放宽，而 VMkernel 适配器用的就是它自己那一个 MAC。
{% endnote %}

{% note primary %}
**生产环境对照**：生产里 vSAN 网络通常是独立且冗余的（双上行），用 25/100GbE 并开启巨型帧（jumbo frame，MTU 9000）以压低存储延迟。我们这里走单链路、`1500` MTU——嵌套下巨型帧未必能在 VMnet 上干净透传，为稳妥不开；这是实验与生产的一处差距。
{% endnote %}

## 4 在集群上启用 vSAN（OSA）并认领磁盘

盘和网络都备齐，回到集群开 vSAN。`YX-Cluster01` → `Configure` → `vSAN` → `Services` → `Configure vSAN`，逐页走：

- **第 1 步 `vSAN ESA`**：这一步是个 ESA 开关 + 预检。我们的嵌套环境过不了 ESA 预检（页面会黄条提示 `your hardware compatibility or cluster configuration is not eligible for vSAN ESA`，并标红 `vSphere Lifecycle Manager (vLCM) configuration`、`Host physical memory compliance check` 两项）——这**属预期，不用去修**。把 `vSAN ESA` 开关**保持关闭**，`NEXT`，向导自动走 OSA 路径。
- **第 2 步 `Services`**：数据服务（去重压缩、加密等）本篇先不开，默认 `NEXT`。
- **第 3 步 `Claim disks`**：给**每台主机**把那块 `50 GB` 闪存盘指派为 **`Cache tier`**、`150 GB` 闪存盘指派为 **`Capacity tier`**——每台形成一个磁盘组。核对顶部 `Total Claimed` 为三台共 6 块、`Unclaimed 0 B`。
- **第 4 步 `Create fault domains`**：跳过（单站点，三台各为默认故障域）。
- **第 5 步 `Review`** → `Finish`。

![](https://img.gulugulublog.com/posts/enterprise-vsphere-lab-05-storage/20260625171822300.png)

vSAN 启用后会自动生成一块 `vsanDatastore`，三台主机的磁盘组都并入其中。

![](https://img.gulugulublog.com/posts/enterprise-vsphere-lab-05-storage/20260625184536878.png)

{% note info %}
**启用后若顶部出现 `You have not finished or skipped the cluster Quickstart. vSAN Health findings are suppressed.`** ——这条横幅会**抑制 vSAN Health 的结果显示**。因为本系列刻意手动配置（vCenter 篇就用 `Add Hosts` 而非 Quickstart 组集群），这条属预期。处理是**跳过 / 忽略 Quickstart（dismiss / skip），而不是去点 `Go to Quickstart` 完成它**——完成它会把你拽进一条龙流程，可能反过来接管你已手动配好的网络与 vSAN。skip 掉后回 `Skyline Health` 点 `RETEST`，才看得到真实健康结果。
{% endnote %}

{% note info %}
**3 台主机 + FTT=1 是怎么冗余的。** 默认存储策略 `vSAN Default Storage Policy` 为 `FTT=1`、`RAID-1`（镜像）：每个对象存**两份数据副本 + 一个见证（witness）**，分散在三台主机上，于是任意一台主机故障，数据仍可访问。这是 vSAN 的最小可用规模——能容忍 1 台故障，但（如 §1 生产对照所说）没有第 4 台来重建，故障期间是「撑着」而非「恢复」。
{% endnote %}

启用后到 `Cluster → Monitor → vSAN → Skyline Health` 看健康。这里要先建立一个判断口径：vSAN 的健康项分两类——**核心数据面**（`vSAN object health`、`vSAN daemon liveness`、`Time is synchronized across hosts and VC`、`Advanced vSAN configuration in sync`、磁盘与网络等）必须绿；**辅助 / 监控类**（`SCSI controller is VMware certified`、`Performance service status`、`vSAN Build Recommendation`、`vSAN cluster configuration consistency`、`Stats primary election` 等）在嵌套环境下常黄常红，且多可一键修或静默，**不挡存储功能**。我们的「磁盘」「控制器」都是虚拟的、本就不在 HCL 上，所以只要核心数据面绿即可。其中 `Stats primary election` / `Stats DB object` 属 Performance Service，在拆组重建后尤其常见——`RETEST`一键修复、或干脆 `Cluster → Configure → vSAN → Services → Performance Service` 关再开重建统计对象，都能消，不消也不影响。

{% note warning %}
**嵌套 vSAN 认领磁盘失败的三类典型报错与排查阶梯**（`Disk Management` 里某台 `Unhealthy`、或 Recent Tasks 报错时，按这个顺序查）：

1. **`Unable to create LSOM file system`——先查主机内存，这条最隐蔽。** LSOM 初始化要吃内存，而承载 VCSA 的 `yx-esxi01` 内存最紧。看该主机 `Summary` 的 `Host memory usage` 告警 / `Memory free`，内存几乎吃满就是它。**把该主机内存抬上去（esxi01 抬到 30 GB）再重建磁盘组**即可。它最容易被误当成「盘的问题」，所以排在最前。
2. **`failed to appear in CMMDS`——多为盘有残留元数据或认领时序。** 处置阶梯：`RETEST` / 刷新 → 拆掉该主机磁盘组重建（`Remove`，选 `No data migration`，新盘无数据）→ `Host → Configure → Storage Devices` 选中该盘 `Erase partitions`（或 SSH `partedUtil` 清分区表）→ 实在不行，Workstation 里给该主机换两块**全新**虚拟盘再认领。

判断标准：修到 `Disk Management` 三台都 `Healthy`、各一个完整磁盘组、`Network partition group` 同为 `Group 1` 为止。
{% endnote %}

{% note primary %}
**生产环境对照**：生产至少 4 台起步（留重建余量）；用经 vSAN 认证的存储控制器（OSA 对 RAID/HBA 控制器有明确的固件/驱动要求）；按需开启去重压缩（OSA 为磁盘组级，ESA 为集群级全局去重）。这些 HCL 与控制器维度，嵌套都演不出来，只能在此点到。
{% endnote %}

## 5 把 VCSA 迁上 vSAN，回收临时盘

`vsanDatastore` 一就绪，上一篇那条自举临时盘就能闭环了。把 VCSA 从 `esxi01-local` 在线迁到 vSAN。

迁移前先确认环境稳定：三台主机状态均为 `Connected`、`vSAN Health` 核心项为绿，且**别在迁移期间同时做其它大规模配置变更**——这是控制面（vCenter）给自己搬家，环境越静越好。

右键 `yx-vc01` → `Migrate` → 选 **`Change storage only`** → 目标 datastore 选 `vsanDatastore`、存储策略用 `vSAN Default Storage Policy` → `Finish`。这是 Storage vMotion，VCSA **不中断**、迁移期间 vCenter 照常可用。

![](https://img.gulugulublog.com/posts/enterprise-vsphere-lab-05-storage/20260625185521636.png)

迁完核对：`yx-vc01` 的 `Summary` / `Datastores` 应显示它已落在 `vsanDatastore` 上、`esxi01-local` 上不再有它的文件。确认无误后回收临时盘：

1. 先在 vCenter 里把 `esxi01-local` 这块 datastore **卸载并删除**（此时它应是空的）。
2. 再到 Workstation，从 `yx-esxi01` 这台 VM 上**移除那块 600 GB 虚拟盘**，宿主 NVMe 上的占用随之释放。

{% note warning %}
顺序别颠倒、也别抢跑：**务必先确认 VCSA 已完整迁到 `vsanDatastore`、`esxi01-local` 确实为空，再删 datastore、再移除虚拟盘。** 在 VCSA 文件还在那块盘上时就去删盘，会直接搞坏正在运行的 vCenter。

若 vCenter 提示 `esxi01-local` 仍被占用、删不掉，**不要强删**：回到该 datastore 的 `Files` 视图，确认是否还残留 VM 文件、ISO、日志或挂载记录，清空后再删。迁移后有残留却直接拆盘，同样会出问题。
{% endnote %}

{% note info %}
这一步闭合了 vCenter 篇的自举：VCSA 当初只能临时落在单台主机的本地盘上、是整套环境最大的单点；现在它住进了横跨三台、带 FTT=1 冗余的 vSAN。再往后（第七篇）启用 vSphere HA，承载它的主机一旦故障，VCSA 就能在另一台上被自动重启——这正是 vCenter 篇生产对照里讲的「VCSA 放共享存储 + HA 重启」，到这里才真正具备了前提。
{% endnote %}

{% note info %}
**vSAN 集群就绪后的开关机习惯。** VCSA 迁到 `vsanDatastore` 后，它不再是 `yx-esxi01` 本地盘上的普通 VM，而是一个存放在 vSAN 对象上、组件分布在三台主机上的控制面。所以开机顺序要从「先起 esxi01、再起 VCSA」改成「**先让 vSAN 集群站起来，再起 VCSA**」——只起一台主机时，vSAN 对象未必凑得齐仲裁（FTT=1 下两份副本 + 见证分散在三台，可访问的主机少于两台时对象就不可达），VCSA 不一定能正常开机。

- **开机**：先启动 OPNsense（确保 DNS/NTP/路由可用），再启动三台 ESXi（`yx-esxi01/02/03`）；等三台的 vSAN 网络与磁盘组恢复、`vsanDatastore` 可访问后，再启动 `yx-vc01`。若用 `VM Startup/Shutdown` 自动起 VCSA，可设在 `yx-esxi01` 上、但**启动延迟要给足**，且前提是三台 ESXi 已基本起来——别只起 esxi01 就指望 VCSA 稳定启动。
- **关机**：正规停机走 `Cluster → Configure → vSAN → Services → Shutdown Cluster` 向导。手工关机时先关业务 VM、VCSA 最后关（走 `Shut Down Guest OS`）；确认 VCSA 已关干净，再关三台 ESXi。别硬断承载 VCSA 的主机，也别让某台 vSAN 主机长时间掉队，否则对象副本与见证组件可能不全，下次启动恢复更费劲。
{% endnote %}

## 6 外置存储对照：TrueNAS 的 iSCSI / NFS（可选）

vSAN 是「把存储融进主机」，与之相对的是传统的「外置共享存储」。这一节用一台 TrueNAS 简要演示后者，作对照、不展开成完整教程。

**准备外置存储端。** 部署一台 TrueNAS 虚拟机 `yx-nas01`（管理口在业务网 `10.0.40.20`，再给它一块网卡接 `YX-Storage` / VLAN 50 作存储数据路径），在其上各建一个 **iSCSI Target（块存储）** 和一个 **NFS 共享（文件存储）**。

**主机端接入。** 三台 ESXi 在 `YX-Storage`（VLAN 50，`10.0.50.0/24`，同样无网关纯二层）上各建一个 VMkernel 作存储数据路径。若做这节对照，`YX-Storage` 段的地址可照下表分配：

| 节点 | Storage IP | 说明 |
| --- | --- | --- |
| `yx-esxi01` | `10.0.50.11` | ESXi Storage VMkernel |
| `yx-esxi02` | `10.0.50.12` | ESXi Storage VMkernel |
| `yx-esxi03` | `10.0.50.13` | ESXi Storage VMkernel |
| `yx-nas01` | `10.0.50.20` | TrueNAS 存储数据口 |

`10.0.50.0/24` 仍不设网关、不经 OPNsense 路由，只承载 ESXi 与 TrueNAS 之间的二层存储流量——这也闭合了第一篇「各 vmk 地址在用到的篇章再分配」的约定。建好 VMkernel 后：

- **iSCSI**：在主机 `Configure → Storage Adapters` 添加 `Software iSCSI` 适配器，填 TrueNAS 的 iSCSI 目标地址（`10.0.50.20`）、`Rescan`，再把发现的 LUN 格式化为 VMFS datastore。
- **NFS**：`New Datastore → NFS`，填 TrueNAS 的 NFS 服务器地址（`10.0.50.20`）与共享路径，挂为 NFS datastore。

**三条路怎么选**——这才是本节的重点：

| 维度 | vSAN（超融合） | 外置 iSCSI（块） | 外置 NFS（文件） |
| --- | --- | --- | --- |
| 存储位置 | 主机本地盘聚合 | 独立存储设备 | 独立存储设备 |
| 计算/存储扩展 | 绑定（加主机=加存储） | 解耦（各自扩） | 解耦（各自扩） |
| vSphere 侧格式 | vSAN 对象 | VMFS（vSphere 格式化） | NFS（存储端管文件系统） |
| 典型场景 | HCI、想少一套外置存储 | 既有 SAN、要块级特性 | 简单、共享、跨主机易挂 |

{% note primary %}
**生产环境对照**：选 vSAN 还是外置阵列，本质是「超融合 vs 存算分离」的取舍——前者省一套独立存储、按主机线性扩展、策略驱动；后者让计算与存储各自独立扩容、契合已有的 SAN/NAS 投资。值得一提的是，VCF 9.x 之后 vSAN 的远程数据存储能力在持续增强：通过 remote vSAN datastore / HCI Mesh / vSAN storage cluster，vSAN 可在跨集群、甚至跨 vCenter 的场景下对外提供共享存储，VCF 9.1 还增强了 OSA 与 ESA 之间的混合挂载。两条路线确在彼此靠拢——但其规划、许可与管理方式，仍不同于传统 NFS/iSCSI 阵列。本系列以 vSAN 为主、外置存储作对照，不必三者全上生产。
{% endnote %}

## 7 验证与检查点

{% note success %}
1. **vSAN datastore 就绪且健康**：`vsanDatastore` 在三台主机上均可见，容量约 **`450 GB`**（本实验为 `449.98 GB`，即 3×150 GB 容量盘聚合；缓存盘不计入可用容量）；`Monitor → vSAN → Skyline Health` 核心数据面为绿（HCL/控制器/Performance service 类告警在嵌套下属预期）。
2. **三个磁盘组到位且健康**：`Cluster → Configure → vSAN → Disk Management` 显示 `3 hosts / 3 vSAN disk groups / 3 capacity disks`，三台各一个磁盘组（1 缓存 + 1 容量、均 `Flash`、`2/2` 盘）、全 `Healthy`、同属 `Group 1`。
3. **黄叹号消失**：`esxi02`/`esxi03` 的 `No datastores configured` 告警随 vSAN 就绪而消除。
4. **VCSA 落位正确**：`yx-vc01` 位于 `vsanDatastore`；`esxi01-local` 已删除、Workstation 上 600 GB 临时盘已移除。
5. **（选学）外置存储**：如做了对照，iSCSI VMFS 与 NFS datastore 已挂载可用。
{% endnote %}

## 结语

到这里，砚行物流终于有了一块横跨集群、带冗余的共享存储：vSAN 把三台主机的本地盘聚成 `vsanDatastore`，VCSA 也从临时本地盘搬进了这块有 FTT=1 保护的存储，vCenter 篇欠下的自举就此还清；外置 iSCSI/NFS 的对照则把另一条存储路线摆在了一起。

共享存储一旦到位，集群真正的「高可用」与「调度」就有了根基。下一篇进入 **HA 与 DRS**：让承载 VCSA 的主机故障时 VCSA 能被自动重启、让负载在三台之间自动均衡与 vMotion——第四篇建好的 `YX-vMotion`（VLAN 20）专用网，也终于要在那时接上 VMkernel、派上用场。

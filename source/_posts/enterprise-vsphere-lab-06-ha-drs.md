---
title: 从零搭建企业虚拟化平台6——高可用：vSphere HA 与 DRS 配置与故障演示
hidden: true
date: 2026-06-25 15:51:00
categories: [Virtualization, vSphere Lab]
tags: [VMware, vSphere, HA, DRS]
description: 配置 vSphere HA 与 DRS：先补齐 vMotion 专用网络（VLAN 20），再依次启用 DRS 负载均衡与 HA 主机故障自动重启，最后实际关停一台主机演示 HA 故障切换全过程与接管时间。
---

# 从零搭建企业虚拟化平台6——高可用：vSphere HA 与 DRS 配置与故障演示

{% note info %}
**📚 从零搭建企业虚拟化平台 · 全系列导航**

- [平台0 · 序章：缘起与全局规划](https://www.catwhiteangel.com/enterprise-vsphere-lab-00-prologue/)
- [平台1 · 环境：OPNsense 与网段搭建](https://www.catwhiteangel.com/enterprise-vsphere-lab-01-environment/)
- [平台2 · 计算：三台嵌套 ESXi](https://www.catwhiteangel.com/enterprise-vsphere-lab-02-esxi/)
- [平台3 · vCenter：部署与建集群](https://www.catwhiteangel.com/enterprise-vsphere-lab-03-vcenter/)
- [平台4 · 网络：vDS 与端口组](https://www.catwhiteangel.com/enterprise-vsphere-lab-04-network/)
- [平台5 · 存储：vSAN 全闪](https://www.catwhiteangel.com/enterprise-vsphere-lab-05-storage/)
- **平台6 · 高可用：HA 与 DRS　← 本篇**
- [平台7 · 身份：AD 域控与 DNS](https://www.catwhiteangel.com/enterprise-vsphere-lab-07-ad-dns/)
- [平台8 · 收尾：时间同步、vLCM 与全系列回顾](https://www.catwhiteangel.com/enterprise-vsphere-lab-08-ntp-wrapup/)
{% endnote %}

上一篇把 vSAN 立起来后，集群终于有了一块三台主机都能访问、且带冗余的共享存储——这正是「高可用」一直缺的最后一块拼图。在此之前，就算某台主机宕了，它上面的虚拟机也只能跟着躺下；现在数据落在 vSAN 上，VM 就有了「换台主机重新跑起来」的可能。

这一篇把这种可能变成自动化的两件事：**vSphere HA**（主机故障时自动重启其上的 VM）与 **vSphere DRS**（用 vMotion 在主机间自动均衡负载）。我们会先补上 DRS 与在线迁移所需的 vMotion 专用网络（第四篇预留的 `YX-vMotion` / VLAN 20 终于派上用场），再依次启用 DRS 与 HA，最后**真的拔掉一台主机**，看 HA 把 VM 在别处拉起来。

<!-- more -->

## 1 HA 与 DRS 各管什么

两者常被并提，但解决的是不同方向的问题：

- **vSphere HA（High Availability，高可用）** 管的是**故障恢复**：某台主机宕机，HA 会把它上面运行的 VM 在集群里其余主机上自动重启。它是被动的、事后的——VM 会有一次重启（不是无缝），但分钟级就能恢复，远好过等人来救。
- **vSphere DRS（Distributed Resource Scheduler，分布式资源调度）** 管的是**负载均衡**：它持续观察各主机的 CPU / 内存负载，用 vMotion 把 VM **在线**迁到更空闲的主机上，让集群整体均衡；新开 VM 时也由它决定放哪台（初始放置）。它是主动的、优化性的。

在本篇实验里，两者**共同受益于**上一篇建好的共享存储，但对 vMotion 网络的依赖并不相同：HA 需要共享存储，好让故障主机上的 VM 能在其它主机重新启动；DRS 则需要共享存储**加** vMotion 网络来做在线迁移。严格说，**HA 本身并不依赖 vMotion**——没有 vMotion，HA 照样能在主机故障后把 VM 在别处重启（它做的是「重新注册并开机」，不是「在线搬」）；但 DRS 的自动均衡、以及本篇顺手做的在线迁移演示，必须先把 vMotion VMkernel 补上。所以这一步我们先建 vMotion 网络。

{% note info %}
**一个贯穿全系列的解耦：HA 由主机执行，不靠 vCenter。** HA 的故障切换是各 ESXi 主机上的 **FDM（Fault Domain Manager）** 代理彼此选举、协同完成的——集群里会选出一个 FDM master，其余为 slave，靠它们之间的心跳判断谁还活着。所以**即便 vCenter 自己宕了，HA 照样能重启 VM**（这正是 vCenter 篇生产对照里那条「VCSA 放共享存储 + HA 重启」成立的根本）。相较之下，**DRS 的自动均衡要 vCenter 在线**——vCenter 宕机的窗口里，自我保护成立、自动调度暂停。
{% endnote %}

## 2 vMotion 网络：给每台主机建 vMotion VMkernel

vMotion 是把一台**正在运行**的 VM 从一台主机迁到另一台、且业务不中断的技术：它把 VM 的内存与运行状态通过专用网络拷到目标主机，切换瞬间完成。它是 DRS 自动均衡与在线迁移演示的搬运工；HA 的故障后重启不依赖 vMotion，但本篇为了完整展示集群调度能力，仍先把 vMotion 网络补上。

第四篇已在 `YX-vDS01` 上建好 `YX-vMotion`（VLAN 20）端口组，这一步给三台主机各建一个启用 vMotion 服务的 VMkernel 接上去。逐台：主机 → `Configure` → `VMkernel adapters` → `Add Networking` → `VMkernel Network Adapter` → 选 `YX-vMotion` → 在 `Enabled services` 勾选 **`vMotion`** → `IPv4 settings` 用 static，按下表填址：

| 主机 | vMotion VMkernel IP | 掩码 | 网关 |
| --- | --- | --- | --- |
| `yx-esxi01` | `10.0.20.11` | `255.255.255.0` | （无） |
| `yx-esxi02` | `10.0.20.12` | `255.255.255.0` | （无） |
| `yx-esxi03` | `10.0.20.13` | `255.255.255.0` | （无） |

`10.0.20.0/24` 同样是第一篇定的**无网关、不路由的纯二层专用段**——vMotion 流量只在 VLAN 20 内东西向流动，不出网、不跨段，故**不填网关**。MTU 保持默认 `1500`。

![](https://img.gulugulublog.com/posts/enterprise-vsphere-lab-06-ha-drs/20260625200726315.png)

{% note info %}
**又一次印证第四篇 §5 的判断**：vMotion vmk 是普通单 MAC 适配器，所以 `YX-vMotion` 端口组保持第四篇的默认 `Reject` 安全策略即可、无需放开。到这里 vMotion、vSAN 两个 vmk 都验证了「单 MAC 不需放宽」这条规律。
{% endnote %}

**顺手验证一次手动 vMotion。** 为了后面 §5 的故障演示，先建一台小测试 VM（取名 `yx-test01`，`1 vCPU` / `1～2 GB` 内存、挂个轻量 Linux Live ISO 即可），存到 `vsanDatastore`、网络接 `YX-Server`。注意 `YX-Server`（VLAN 40）现在还没有 DHCP（域控要到下一篇才立），所以在 `yx-test01` 里**手动配一个静态地址**，例如 `10.0.40.100/24`、网关 `10.0.40.1`——这样你才能在它上面持续 `ping`（比如 ping 网关），用来观察迁移期间是否丢包。开机后右键它 → `Migrate` → **`Change compute resource only`** → 选另一台主机 → `Finish`。能看到它**在线**迁过去、期间 ping 不中断，就说明 vMotion 网络通了。

{% note primary %}
**生产环境对照**：生产的 vMotion 网络通常独立且冗余，用 25GbE 或更高、并开巨型帧（MTU 9000）以缩短大内存 VM 的迁移时间；大规模环境还会配多个 vMotion vmk 做多网卡并行。我们这里单链路、`1500` MTU，够演示但迁移会慢些。
{% endnote %}

## 3 启用 vSphere DRS

`YX-Cluster01` → `Configure` → `vSphere DRS` → `EDIT` → 打开 `vSphere DRS`：

- `Automation Level`：选 `Fully Automated`（全自动）——DRS 会自动用 vMotion 均衡负载、也自动决定新 VM 放哪台。想先只看建议、不自动迁，可选 `Partially Automated`（部分自动，只做初始放置 + 给迁移建议）。
- `Migration Threshold`：保持默认（中档）。
- `Finish`。

启用后，DRS 会接管初始放置与负载均衡。在我们这套三台、负载又轻的实验里，DRS 未必会频繁迁移（本就均衡），但机制已经生效——§2 那次手动 vMotion 演示的，正是 DRS 在背后用的同一套搬运能力。

{% note success %}
**实测：DRS 真的自动迁了。** 本实验把 `yx-test01` 建在了内存最紧的 `yx-esxi01` 上（VCSA + vSAN 开销已让它只剩约 7 GB），启用 `Fully Automated` 后没等手动操作，DRS 就自己把它在线迁到了空闲的 `yx-esxi03`。`yx-test01 → Monitor → Tasks/Events` 里能看到这串事件：`Hot migrating ... with encryption`（`VmHotMigratingWithEncryptionEvent`，vMotion 默认加密传输）→ `Migrating off host ...`（`VmEmigratingEvent`）→ **`Migrated from yx-esxi01 to yx-esxi03 by DRS`（`DrsVmMigratedEvent`）**。最后这条 `... by DRS`、发起者 `System`，就是「DRS 自动均衡」最直接的证据——也顺带替 §2 完成了「在线迁移不停机」的验证。
{% endnote %}

![](https://img.gulugulublog.com/posts/enterprise-vsphere-lab-06-ha-drs/20260625222534943.png)

![](https://img.gulugulublog.com/posts/enterprise-vsphere-lab-06-ha-drs/20260625222154804.png)

{% note info %}
**启用 DRS 后你会看到几台 `vCLS` 虚拟机自动出现，别去动它们。** vCLS（vSphere Cluster Services，集群服务）是一组系统托管的小代理 VM，用来保障 DRS 等集群服务的可用性，DRS 依赖至少 1 台 vCLS 在跑。我们这套是 ESXi 8.0 Update 3，用的是新的 **Embedded vCLS**：它以容器形式打包在 ESX 内、**不占用 datastore**（不会吃 `vsanDatastore` 容量），开关机时自动重建。数量上，8.0 U3 的 Embedded vCLS 架构下，2 台及以上主机的集群常见为 **2 个**实例；旧版 External vCLS 则可能表现为 1～3 台存放在 datastore 上的小 VM。无论哪种，它们都在清单的 `vCLS` 文件夹下、被 HA 忽略、由系统管理——**不要手动迁移、关机或删除**，否则可能搅乱 DRS。
{% endnote %}

{% note primary %}
**生产环境对照（兼版本提醒）**：vCLS 自 vSphere 7.0 U1 引入，最初是部署在 datastore 上的 OVF 虚拟机（现称 External vCLS）；8.0 U3 改成不占存储的 Embedded vCLS。而从 **vCenter 9.0 起，vCLS 被弃用**：ESX 9 在主机上内置了分布式键值存储来维护集群状态，集群不再需要这些代理 VM，9.0+ 可用 `Retreat Mode` 关闭 vCLS 而**不影响 DRS/HA**。但在我们这套 8.0 U3 上正相反——**别去开 Retreat Mode**，8.x 下关掉 vCLS 会让 DRS 停摆、HA 放置变次优。（Retreat Mode 的入口在 `Cluster → Configure → vSphere Cluster Services → General → EDIT VCLS MODE`，本系列不要用。）
{% endnote %}

## 4 启用 vSphere HA

`YX-Cluster01` → `Configure` → `vSphere Availability` → `EDIT` → 打开 `vSphere HA`。几个关键项：

- `Host Failure Response` / `Failure Response`：`Restart VMs`——主机故障时在别处重启其 VM。
- `Response for Host Isolation`（主机隔离响应）：vSAN 集群推荐 **`Power off and restart VMs`**。「隔离」指某台主机与其它主机失联了、但自己其实没死，还在跑着 VM。问题在于：它一旦失联，集群里其它主机会以为它故障、可能在别处把同一批 VM 重启起来——若此时被隔离的主机还让原 VM 继续运行、继续往 vSAN 写数据，就会出现「同一个 VM 在两处同时跑、同时写盘」的冲突。所以推荐让被隔离的主机**主动把自己的 VM 关掉**（Power off），腾清后再由 HA 在健康的主机上干净地重启，避免两边抢着写同一份数据。
- `Admission Control`（准入控制）：设 `Host failures cluster tolerates = 1`——预留一台主机的容量，保证任一台故障时还有地方重启 VM。
- `VM Monitoring`：可选，开了能在 VM 卡死（VMware Tools 心跳停）时重启该 VM。

{% note info %}
**vSAN 开着时，HA 的心跳走 vSAN 网络、不走管理网。** 一旦集群启用了 vSAN，vSphere HA 各主机间的代理通信与网络心跳会自动改用 **vSAN 网络（VLAN 30）**，而不是管理网。这是 vSAN 集群的既定行为——所以我们上一篇建的 `YX-vSAN` vmk，既扛存储同步、也扛 HA 心跳。
{% endnote %}

{% note warning %}
**纯 vSAN 环境会报「心跳数据存储不足」，这是预期的。** HA 除了网络心跳，还会用「数据存储心跳」（datastore heartbeating）做旁证，以便区分「主机真死了」和「只是网络隔离」。但 **`vsanDatastore` 不能用作 HA 的心跳数据存储**——它需要一块**非 vSAN** 的 VMFS/NFS 数据存储。我们上一篇把外置 iSCSI/NFS 对照列为选学、没真挂，所以集群里没有非 vSAN 数据存储，HA 会给一条 `The number of vSphere HA heartbeat datastores ... is less than required` 之类的告警。这条在纯 vSAN 实验环境里属预期，**不影响 HA 对「主机硬故障」的基本重启能力**；但它确实意味着少了一层非 vSAN datastore heartbeat 作辅助判断——在复杂的网络隔离场景里，少这层旁证会让「到底是主机死了还是只是失联」更难判。若你做了上一篇的 iSCSI/NFS 对照，那块非 vSAN datastore 正好能被 HA 选作心跳盘，这条告警随之消失。
{% endnote %}

{% note info %}
**启用 HA 后还会遇到的另两条告警，都不是真故障：**

- **`There was an error unconfiguring the vSphere HA agent on this host. To solve this problem, reconnect the host to vCenter Server.`** ——某台主机配置 FDM（HA 代理）时卡了一下（嵌套 + 内存紧时偶发）。按提示来：右键该主机 → `Connection` → `Reconnect`，或集群 `vSphere Availability` 里 `Reconfigure for vSphere HA`，重推一遍即可，随后 `Reset to Green` 清残留。
- **`This host currently has no management network redundancy`** ——HA 检查到管理网没有冗余。这是**设计使然**：我们每台主机只有一块管理网卡（`vmnic0`→VMnet2），嵌套实验没必要配双管理网卡。正确做法不是加网卡，而是告诉 HA 别再提醒：集群 `vSphere Availability → Edit → Advanced Options` 加一条 `das.ignoreRedundantNetWarning = true`，再对三台 `Reconfigure for vSphere HA`，三台的黄叹号即清。
{% endnote %}

到这里，vCenter 篇埋下的那条「VCSA 放共享存储 + HA 重启」终于配齐了前提：VCSA 现在在 vSAN 上、HA 也开了，承载它的主机一旦故障，理论上 FDM 会在另一台把 VCSA 重启起来。

{% note warning %}
**但在本实验这套「紧」配置下，HA 不一定真能把 VCSA 重启起来——这是要诚实说清的一处。** VCSA（Tiny）要 `14 GB` 内存，而 `yx-esxi02`/`esxi03` 各只有 `12 GB`，放不下。也就是说，若 `yx-esxi01` 故障，HA 想在另两台重启 VCSA 会因内存不足而失败。这不是 HA 的问题，而是我们为塞进单机把内存抠得太紧。所以：**VCSA 的自我保护在「主机有足够余量」的正常集群里成立，在我们这套里只能作为概念**；下面 §5 的故障演示，改用那台小测试 VM（内存小、放得下）来真切地看 HA 动作。
{% endnote %}

{% note primary %}
**生产环境对照**：生产的准入控制按 `N+1`（甚至 `N+2`）正经预留容量，确保故障后被重启的 VM（含 VCSA 这类控制面）都有地方落；管理集群与工作负载集群分开，VCSA 落在有充足余量的管理集群里。我们这套三台、内存贴边，准入控制若设得严还可能挡住开机——实验里可按需把它调松或临时关掉，但要明白这意味着放弃了「留一台余量」的保证。
{% endnote %}

## 5 故障演示：拔掉一台主机

理论说够了，来真的。用 §2 建的 `yx-test01` 做被保护对象：

1. **确认 `yx-test01` 开机、且当前在某台主机上**（比如让它待在 `yx-esxi03`，可用 vMotion 迁过去）。记下它现在的主机。
2. **模拟主机硬故障**：到 Workstation，把 `yx-esxi03` 这台 VM **直接断电**（`Power Off`，不是优雅关机——就是要模拟主机突然挂掉）。
3. **观察 HA 动作**：vCenter（在 `yx-esxi01` 上，没被我们干掉）保持可用，正好用来看戏。开好 `YX-Cluster01 → Monitor → vSphere HA → Summary` 和 `yx-test01 → Monitor → Events` 两个页：
   - 几十秒后，`yx-esxi03` 在清单里变成 `Not responding` / 失联，事件流里出现 `... is disconnected`（`VmDisconnectedEvent`）；
   - HA（存活主机的 FDM）判定它故障，把 `yx-test01` 在 `yx-esxi01` 或 `yx-esxi02` 上**自动重启**，事件流里出现 **`vSphere HA restarted this virtual machine`（`com.vmware.vc.ha.VmRestartedByHAEvent`，类型 Warning）**——这条就是 HA 重启的铁证；随后 `Host is connected`（VM 在新主机连回）、`Alarm ... changed to Green`（恢复正常）。
   - `Monitor → vSphere HA → Summary` 同步反映状态：`Hosts failed: 1`、`Primary` 指向某台存活主机、`Virtual Machines — Protected` 数不变、`Unprotected: 0`。

{% note success %}
**本实验实测：从主机失联到 VM 在别处重启完成，约 1 分钟。** 事件流里 `yx-esxi03 ... is disconnected` 在 `10:15:06`、`vSphere HA restarted this virtual machine` 在 `10:16:05`，间隔约 60 秒。嵌套 + 内存紧下这个量级正常（生产更快）。另外，被重启到的那台主机会弹一条 `Running VMware ESX in a virtual machine will result in degraded performance ...`——这是**嵌套 ESXi 的固有提示**（从承载它的主机发出，也顺带告诉你 VM 被重启到了哪台），不是故障。
{% endnote %}
4. **vSAN 这边**：FTT=1 下少一台仍可访问，`yx-test01` 的数据没丢。vSAN 会起一个默认 60 分钟的重建计时——但三台只剩两台、没有第三处可重建副本，所以它会**等 `yx-esxi03` 回来**而非立即重建（这正是 §1 上一篇说的「3 台无重建余量、故障期是撑着」）。
5. **恢复**：把 `yx-esxi03` 重新开机，它重新入列，vSAN 自动 resync 把副本补齐，集群回到健康。

![](https://img.gulugulublog.com/posts/enterprise-vsphere-lab-06-ha-drs/20260625221655568.png)

![](https://img.gulugulublog.com/posts/enterprise-vsphere-lab-06-ha-drs/20260625221724506.png)

{% note info %}
**这次演示坐实了 §1 的解耦**：把 `yx-esxi03` 干掉时，`yx-test01` 的重启是 `yx-esxi01`/`esxi02` 上的 FDM 自己完成的，全程不需要"故障主机上的什么东西"配合。还有一个细节很能说明问题：故障后看 `vSphere HA → Summary`，`Primary`（FDM master）会指向一台存活主机——如果原来的 master 正好在被干掉的那台上，存活主机会**自动重新选举**出新 master，这套选举与重启全程不依赖 vCenter。反过来想：如果当初干掉的是承载 VCSA 的 `yx-esxi01`，FDM 仍会照样重启 VM——只是 vCenter 会短暂失联、你得等它在别处起来（或如 §4 所说，本实验内存不够它起不来）。**救 VM 的是存活主机，不是 vCenter。**
{% endnote %}

{% note warning %}
**别一次拔两台。** 三台、FTT=1 只能容忍**一台**故障：同时倒两台，vSAN 对象失去仲裁、VM 直接不可访问，且准入控制本就只预留了一台的余量。演示一次只动一台，看完恢复了再说。
{% endnote %}

## 6 验证与检查点

{% note success %}
1. **vMotion 可用**：三台主机各有一个 `vMotion` 服务的 VMkernel（`10.0.20.11/12/13`、VLAN 20）；手动 `Change compute resource only` 能在线迁移 VM。
2. **DRS 已启用**：`vSphere DRS` 为 `Fully Automated`；vCLS / Embedded vCLS 状态正常——界面里若显示系统托管的 vCLS 实例，不要手动处理。
3. **HA 已启用**：`vSphere Availability` 开启；三台主机在 HA 中均为已保护状态；除了预期的「心跳数据存储不足」告警外无其它 HA 配置错误。
4. **故障切换可用**：拔掉一台主机后，HA 在存活主机上把 `yx-test01` 自动重启；主机恢复后 vSAN resync 回健康。
5. **演示后清理**：故障演示用的 `yx-test01` 可保留作后续测试，或关机/删除以省内存（本实验内存紧）。
{% endnote %}

![](https://img.gulugulublog.com/posts/enterprise-vsphere-lab-06-ha-drs/20260625222813515.png)

![](https://img.gulugulublog.com/posts/enterprise-vsphere-lab-06-ha-drs/20260625223203248.png)

## 结语

到这里，砚行物流的平台在共享存储之上又叠了两层韧性：**HA** 让主机故障不再等于业务停摆，**DRS** 让负载在三台之间自动找平。从第一篇的物理规划到这一篇，整套虚拟化的**基础设施层**——计算、网络、存储、高可用——已经基本成形。

但平台到此还缺一样东西：**身份**。现在登 vCenter 用的还是 SSO 本地管理员 `administrator@vsphere.local`，没有统一的目录服务，也没有给后续业务系统提供认证的地方。下一篇进入 **Active Directory 与 DNS**：在 `YX-Server`（VLAN 40）上立起域控 `yx-dc01`/`yx-dc02`，把 DNS 收编进来，再把 vCenter 作为外部身份源接入 AD——第四篇建好、却一直空着的 `YX-Server` 端口组，终于要迎来它的第一批正式住户。

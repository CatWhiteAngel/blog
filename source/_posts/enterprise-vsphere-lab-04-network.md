---
title: 从零搭建企业虚拟化平台4——网络进阶：引入 vDS 与 VLAN 划分
hidden: true
date: 2026-06-25 08:55:00
categories: [Virtualization, vSphere Lab]
tags: [VMware, vSphere, vDS, VLAN]
description: 从标准交换机迁移至分布式交换机（vDS）：创建横跨集群的 vDS，把预留的第二块上行链路纳入中继干道，按规划划分业务 VLAN，并顺势完成管理网隔离，含迁移过程中避免管理网中断的注意事项。
---

# 从零搭建企业虚拟化平台4——网络进阶：引入 vDS 与 VLAN 划分

{% note info %}
**📚 从零搭建企业虚拟化平台 · 全系列导航**

- [平台0 · 序章：缘起与全局规划](https://www.catwhiteangel.com/enterprise-vsphere-lab-00-prologue/)
- [平台1 · 环境：OPNsense 与网段搭建](https://www.catwhiteangel.com/enterprise-vsphere-lab-01-environment/)
- [平台2 · 计算：三台嵌套 ESXi](https://www.catwhiteangel.com/enterprise-vsphere-lab-02-esxi/)
- [平台3 · vCenter：部署与建集群](https://www.catwhiteangel.com/enterprise-vsphere-lab-03-vcenter/)
- **平台4 · 网络：vDS 与端口组　← 本篇**
- [平台5 · 存储：vSAN 全闪](https://www.catwhiteangel.com/enterprise-vsphere-lab-05-storage/)
- [平台6 · 高可用：HA 与 DRS](https://www.catwhiteangel.com/enterprise-vsphere-lab-06-ha-drs/)
- [平台7 · 身份：AD 域控与 DNS](https://www.catwhiteangel.com/enterprise-vsphere-lab-07-ad-dns/)
- [平台8 · 收尾：时间同步、vLCM 与全系列回顾](https://www.catwhiteangel.com/enterprise-vsphere-lab-08-ntp-wrapup/)
{% endnote %}

到上一篇为止，三台主机的网络都还停在最朴素的状态：各自一台标准交换机（vSwitch0），只用 `vmnic0`（VMnet2）扛着一条不打标签的管理网。而第二篇就给每台预留的第二块网卡 `vmnic1`（接 VMnet3 中继干道）一直空挂着没接活。

这一篇把它接上：创建一台横跨整个集群的分布式交换机（Distributed Switch，vDS），把 `vmnic1` 这根干道纳入，按第一篇的规划在上面划出各业务 VLAN；并顺势落地一件一直说要做、却得等 VLAN 成形才好做的事——管理网隔离。

<!-- more -->

## 1 为什么要引入 vDS

标准交换机（Standard Switch，vSS）是**每台主机各一份**的东西：你在 esxi01 上建的端口组、配的 VLAN、调的安全策略，esxi02/03 上都得照着再来一遍。三台还能手抖对付，规模一上去，配置漂移（config drift）几乎是必然——某台少打一个 VLAN 标签、某台安全策略没对齐，故障就藏在这种不一致里。

分布式交换机（vDS）把交换机这个对象**上提到 vCenter** 统一管理：端口组、VLAN、上行、安全与流控策略只定义一次，自动一致地下发到集群里所有主机。要澄清一点：vMotion 与 vSAN 并不**强制**依赖 vDS，用标准交换机同样能跑通；但在多主机场景下，vDS 能让这些专用网络的端口组、VLAN 与策略集中维护，显著降低配置漂移风险。而 NIOC（网络 I/O 控制）、LACP、端口镜像这些进阶能力，才是 vDS 相比 vSS 的主要价值所在。正因为 vDS 依赖 vCenter，它必须排在上一篇之后——现在 vCenter 就位了，时候到了。

{% note info %}
**一个常被误解的点：vDS 依赖 vCenter，但它的「转发」不依赖 vCenter。** vDS 分两个面：管理面（control plane）在 vCenter——你增删端口组、改策略都经它；数据面（data plane）仍在每台主机本地，主机会把 vDS 配置缓存在本地数据库里。所以即便 vCenter 宕机，已有的 vDS 端口组照常转发流量、虚拟机网络不断——你只是暂时不能改 vDS 配置而已。这一点和上一篇「HA 由主机 FDM 执行、不依赖 vCenter」是同一种解耦思路。
{% endnote %}

## 2 本篇的网络蓝图：哪段走 vSS、哪段走 vDS

每台主机有两块上行网卡，分工早在第一、二篇就定了：

| 上行网卡 | 接入 | 交换机 | 承载 |
| --- | --- | --- | --- |
| `vmnic0` | VMnet2（不打标签的原生段） | 保留在标准交换机 vSwitch0 | 管理网 VLAN 10 |
| `vmnic1` | VMnet3（中继干道，带标签） | 本篇新建的 vDS | 业务各 VLAN（20/30/40/50/60） |

也就是说，**管理网继续留在标准交换机上、不迁 vDS**，本篇只把空闲的 `vmnic1` 这根干道接到 vDS。这么分有两层考虑：其一，管理网走的是另一块网卡、另一个 VMnet，本就和干道物理分离；其二，迁移管理网到 vDS 是有风险的操作（一旦中途失手，可能丢掉主机管理连通性），实验室里没必要为此冒险。生产里确实常把管理网也并入 vDS（配合专门的迁移流程与回滚预案），这点留作了解，本系列不做。

{% note info %}
**VMnet3 这根「干道」真能透传 802.1Q 标签吗？** 设计上可以。第一篇已经在 OPNsense（`yx-fw01`）的第三块网卡（`em2`，接 VMnet3）上创建了 VLAN 40 / VLAN 60 子接口，相当于把干道的**一端**准备好了；本篇则把**另一端**接到 ESXi 的 vDS 上，由分布式端口组打出 VLAN 标签。真正的**端到端验证**，是本篇后面临时把测试 VM 接到 `YX-Server`（VLAN 40）、再 ping `10.0.40.1` 那一步——能通，才说明 VLAN 标签确实从 vDS 顺着 VMnet3 贯通到了 OPNsense 的对应接口、并由它做 VLAN 间路由。
{% endnote %}

## 3 创建分布式交换机

在 vSphere Client 切到 `Networking`（清单视图左侧第四个图标），右键 `YX-Datacenter` → `Distributed Switch` → `New Distributed Switch`：

- `Name`：`YX-vDS01`。
- `Version`：选与主机匹配的最新版本（`8.0.x`）。版本决定可用特性，按主机版本走即可。
- `Configure settings`：`Number of uplinks` 设为 `1`——因为每台主机只拿 `vmnic1` 这一块网卡上联本 vDS。`Network I/O Control` 保持 `Enabled`。把 `Create a default port group` **取消勾选**，端口组我们按 VLAN 自己建。
- `Finish`。

![](https://img.gulugulublog.com/posts/enterprise-vsphere-lab-04-network/20260625140505998.png)

{% note info %}
`Number of uplinks` 等于「每台主机将接入本 vDS 的物理网卡数」。我们每台只有一根干道 `vmnic1`，故为 1。真实环境里一台主机通常给同一 vDS 上多块网卡做 teaming/LACP，那时这里就不止 1。
{% endnote %}

## 4 按 VLAN 创建分布式端口组

vDS 建好后，右键 `YX-vDS01` → `Distributed Port Group` → `New Distributed Port Group`，逐个建出各业务 VLAN 的端口组。每个端口组的 `VLAN type` 选 `VLAN`，`VLAN ID` 填对应编号：

| 端口组 | VLAN ID | 用途 | 消费篇章 |
| --- | --- | --- | --- |
| `YX-vMotion` | 20 | vMotion 专用网 | 第七篇（HA/DRS） |
| `YX-vSAN` | 30 | vSAN 存储网 | 第六篇（存储） |
| `YX-Server` | 40 | 业务 / 服务器网 | 第八篇（域控等）起 |
| `YX-Storage` | 50 | 外置存储网 | 第六篇（iSCSI/NFS 对照） |
| `YX-Client` | 60 | 客户端网 | 按需 |

![](https://img.gulugulublog.com/posts/enterprise-vsphere-lab-04-network/20260625141034491.png)

这里只是把「线路」铺好，真正用它们的 VMkernel 适配器（vMotion、vSAN、存储的 vmk）和业务虚拟机，分别在各自篇章再接上——这与第一篇「各 vmk 地址在用到的篇章再分配」的约定一致。管理网 VLAN 10 不在此列，它留在标准交换机上。

## 5 关键：分布式端口组的二层安全策略

这一步是第三篇埋下的伏笔到期兑现，但要先把一个常见误解纠正过来。

第三篇讲过：标准交换机上 `Forged transmits` 默认是 `Accept`，而新建 vDS / 分布式端口组时，`Promiscuous mode`、`MAC address changes`、`Forged transmits` 通常比 vSS 更收紧（本实验中新建的端口组三项均为 `Reject`，实际请以端口组 `Policies → Security` 页面显示为准）。

但**这并不意味着接到这些端口组上的普通虚拟机会被丢包**。一台普通 VM（比如后续接到 `YX-Server` 的域控）用的是它**自己 vNIC 的 MAC** 收发流量——vDS 不会因为这个 MAC 与上行 `vmnic1` 的 MAC 不同，就把它当作伪造（forged）而丢弃。换句话说，单 MAC 的普通 VM 在三项默认 `Reject` 下照样通，无需任何放宽。

真正需要放开的，是「**一个 VM 代表多个 MAC 收发流量**」的场景：虚拟防火墙、虚拟路由器、桥接、CARP/VRRP、IDS/IPS 旁路，或在这套环境里继续嵌套另一层 hypervisor。这类 VM 可能以**非自身 vNIC 的源 MAC** 发包（主要涉及 `Forged transmits`，它管的是出向帧的源 MAC 是否与端口有效 MAC 匹配），也可能在虚拟 MAC、故障切换或桥接场景中改变自身 MAC（涉及 `MAC address changes`，它管的是 VM 改了 vNIC MAC 后入向流量是否仍被接收）；同时，它们还可能需要接收**目标 MAC 并非自身**的帧（涉及 `Promiscuous mode` 或 `MAC Learning`）。这才是会「不报错、只是不通」的地方。

那么本篇这五个端口组，现在要不要动安全策略？**不用**——它们规划里接的都是普通单 MAC VM（域控、TrueNAS、跳板机等），保持默认 `Reject` 就好。此刻就把 `YX-Server`/`YX-Client` 三项放开，是为一个尚不存在的场景做安全降级，没必要。

正确的做法是**按需、且就具体端口组**：等哪天确实要在某个端口组上跑虚拟防火墙 / 路由器 / 再嵌套这类多 MAC 负载时，再去改**那一个**端口组。改法留作参考——`Networking` → 选中该端口组 → `Configure` → `Settings` → `Policies` → `EDIT` → `Security`，按需把 `Promiscuous mode` / `MAC address changes` / `Forged transmits` 设为 `Accept`。两点要记住：

- 安全策略是**每个分布式端口组各自一份**，vDS 并没有「设一次、其余端口组自动继承」的机制，所以是逐个端口组改；要给多个端口组批量设同一策略，GUI 没有一键多选，得用 PowerCLI（`Get-VDPortgroup ... | Get-VDSecurityPolicy | Set-VDSecurityPolicy`）。
- 比全开混杂模式更现代、也更接近生产的，是 **MAC Learning**（vSphere 6.7 起）：它让 vSwitch 学习 vNIC 后面的多个 MAC，在不开混杂模式的前提下转发相关流量，避免混杂模式把同端口组内大量无关流量也复制进每台 VM（那正是混杂模式的性能代价）。它在 GUI 中基本不暴露，通常经 PowerCLI / API 配置；真要承载多 MAC 负载时，优先选它。

{% note warning %}
别因为「vDS 看着更高级」就以为它的默认更宽松——恰恰相反，新建端口组通常三项更收紧。但也别为此急着放开：普通单 MAC 的 VM（域控、TrueNAS、跳板机等）在默认 `Reject` 下完全能通。本系列当前规划的负载都属此类，所以这五个端口组**现在一个都不用动**，保持默认即可——只有将来真接入多 MAC 负载时，才就那一个端口组按需放开（或用 MAC Learning）。
{% endnote %}

{% note primary %}
**生产环境对照**：把这三项放开是一次实打实的二层安全降级（允许嗅探与 MAC 伪造），生产默认应保持 `Reject`，仅在确有需要（虚拟网络设备、嵌套、某些 NFV/IDS 旁路）时**按端口组精确**放开，并优先用 `MAC Learning` 而非混杂模式。我们这里保持默认、按需才放，正是这个原则的落地。
{% endnote %}

## 6 把主机与干道网卡接入 vDS

线路与策略就绪，最后把三台主机的 `vmnic1` 挂到这台 vDS 上。右键 `YX-vDS01` → `Add and Manage Hosts` → `Add hosts`，勾选三台主机，进入 `Manage physical adapters`：

- 给每台主机，把 **`vmnic1`** 指派到 `Uplink 1`。
- **不要碰 `vmnic0`**——它在标准交换机上扛着管理网，动它就可能断掉主机管理连通。
- 本篇没有 VMkernel 适配器要迁移（vMotion/vSAN 的 vmk 留到各自篇章），所以 `Manage VMkernel adapters` 一步保持空、直接下一步。

`Finish` 之后，三台主机的 `vmnic1` 就成了 `YX-vDS01` 的上行。

![](https://img.gulugulublog.com/posts/enterprise-vsphere-lab-04-network/20260625142559422.png)

{% note warning %}
指派上行前务必认准哪块是 `vmnic1`：它是当前**未被 vSwitch0 占用**的那块（vSwitch0 上是 `vmnic0`）。指错成 `vmnic0` 会把管理网卡从标准交换机上拽走，直接断管理。每台主机在 `Configure → Networking → Physical adapters` 里能看清 `vmnic0`/`vmnic1` 各自的连接。
{% endnote %}

## 7 验证

{% note success %}
1. **vDS 拓扑正确**：`YX-vDS01` 的 `Configure → Topology` 里，三台主机各有一块 `vmnic1` 接在 `Uplink 1`、链路 up；五个端口组在列、`VLAN ID` 与上表一致。
2. **管理网未受影响**：三台主机仍 `Connected`，`vmnic0` / vSwitch0 / 管理网照旧。
3. **端口组安全策略保持默认**：五个端口组的 `Security` 维持新建默认（本实验为三项 `Reject`），本篇无需放开——普通单 MAC VM 不受影响（见 §5）。
{% endnote %}

要做一次**端到端的 VLAN 连通验证**（推荐，能一次性证明 VLAN 标签贯通 + 普通 VM 连通性），可临时建一台小虚拟机：放到 `YX-Server`（VLAN 40），给它 `10.0.40.0/24` 段的地址（如 `10.0.40.100`、网关 `10.0.40.1`），开机后 ping 网关 `10.0.40.1`。能通，就说明 vDS 在 `vmnic1` 上打的 VLAN 40 标签顺着 VMnet3 干道到了 OPNsense 的 VLAN 40 接口、且端口组策略没有影响普通 VM 的基础连通性。验证完删掉即可。若不想现在建测试机，这条留到第八篇域控接入 `YX-Server` 时自然会被验证。

需要说明的是：普通单 MAC 的测试机能通，只验证了 VLAN 链路与普通 VM 的连通，并不能证明多 MAC 场景的安全策略「到位」——因为普通 VM 本就不依赖 `Promiscuous mode` / `Forged transmits` / `MAC address changes`（见 §5）。多 MAC 端口组的策略是否生效，要等真有虚拟防火墙 / 路由器 / 再嵌套这类负载接入时才谈得上验证。

{% note info %}
vDS 自带的 `Health Check`（VLAN/MTU 检查）在物理环境里很好用，但它依赖上联物理交换机的配合；我们的「上联」是 Workstation 的 VMnet，嵌套下未必给出有意义的结果，故以上面的测试机连通法作为本篇的功能判据更可靠。
{% endnote %}

## 8 管理网隔离：受控出站 + 拒绝入站

VLAN 一划出来，各网段有了明确边界，正好把管理网的安全姿态收一收。原则一句话：**管理网能主动够到它需要的外部资源（受控出站），但外部 / 其它网段不能主动发起连到管理网（拒绝入站）。** 这正是有状态防火墙（stateful firewall）的天然姿态——管理主机自己发起的会话，其回包算「已建立连接」放行；互联网或它段凭空发起、试图连管理口的包，命不中任何会话，被默认拒绝。所以「受控出站」与「拒绝外部主动访问」并不矛盾。

管理网是整套环境最敏感的面，拿下它等于拿下一切，因此这层隔离在生产里是硬要求。落到 OPNsense（`yx-fw01`）上分两头做。

动手前先在 `Firewall → Aliases` 把别名建齐，规则一律引用别名而非裸地址——日后扩展网段或端口只需维护别名，不必逐条改规则：

| Name | Type | Content |
| --- | --- | --- |
| `MGMT_NET` | Network(s) | `10.0.10.0/24` |
| `SERVER_NET` | Network(s) | `10.0.40.0/24` |
| `CLIENT_NET` | Network(s) | `10.0.60.0/24` |
| `FW_MGMT_IP` | Host(s) | `10.0.10.1` |
| `MGMT_TO_FW_PORTS` | Port(s) | `22`、`53`、`123`、`443` |
| `WEB_PORTS` | Port(s) | `80`、`443` |

{% note warning %}
为什么端口也要做别名：OPNsense 规则的端口字段是 `Single port or range`，**一次只能填一个端口或一段连续范围**，填不了 `22,53,123,443` 这种离散列表。所以离散端口必须先做成 `Port(s)` 类型的别名，规则里再引用。端口别名里**只填端口号、不带协议**；TCP/UDP 的区分在规则的 `Protocol` 字段选。
{% endnote %}

![](https://img.gulugulublog.com/posts/enterprise-vsphere-lab-04-network/20260625161245082.png)

**其一，出站收敛（在 `LAN`／管理网接口，`Direction = in`）。** 这里的「出站」是从管理网主机视角说的；从 OPNsense 视角看，数据包是从 `LAN` 接口**进入**防火墙的，因此接口规则应匹配 `in` 方向（这也是 OPNsense 的默认——在流量来源接口上写入向规则，回包由 state 自动放行）。**别写成 `out`**：`out` 匹配的是防火墙往管理网方向发出的流量，而非管理主机发起的流量，规则会匹配不到、表现得很迷惑。

现状是一条 `Default allow LAN to any` 全放。把它换成下面这组精确规则，自上而下、首条匹配，其余由隐式拒绝兜底：

| # | Protocol | Source | Src Port | Destination | Dst Port | 动作 | 用途 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `TCP/UDP` | `MGMT_NET` | （空） | `FW_MGMT_IP` | `MGMT_TO_FW_PORTS` | pass | 向本地 OPNsense 取 DNS/NTP，并保留对防火墙的 GUI/SSH 管理 |
| 2 | `any` | `MGMT_NET` | （空） | `SERVER_NET`、`CLIENT_NET` | （空） | pass | 跨段——第八篇 vCenter/主机找域控等 |
| 3 | `TCP` | `MGMT_NET` | （空） | `any` | `WEB_PORTS` | pass | 仅放补丁 / vLCM depot / 可选 CEIP·遥测的 HTTP/HTTPS |
| — | — | `MGMT_NET` | — | `any` | — | （隐式 deny） | 其余出站一律拒绝 |

{% note warning %}
- **`Source Port` 一律留空。** 源端口是客户端的临时高位端口（随机），不该限定。若把目的端口也填进 `Source Port`，规则几乎永远匹配不到、等于失效。**只在 `Dst Port` 限定端口。**
- **`Protocol` 别用 `any`。** 端口只对 TCP/UDP 有意义；`Protocol = any` 时目的端口字段不生效，规则 1/3 就退化成「放行管理网到目标的所有协议」，端口限制白做。所以规则 1 选 `TCP/UDP`、规则 3 选 `TCP`；规则 2 本就要放整段跨段流量、不限端口，才保持 `any`。
{% endnote %}

这里的「可路由的内部网段」只指经 OPNsense 路由、有网关的段（当前是 `SERVER_NET`、`CLIENT_NET`）。`vMotion`（`10.0.20.0/24`）、`vSAN`（`10.0.30.0/24`）、`Storage`（`10.0.50.0/24`）按第一篇的规划是**无网关、不路由的纯二层专用网段**，不要把它们加进这条 routed 规则——它们既不经 OPNsense 转发，也不该出网。

这里还有个值得点出的便利：**因为 DNS 与 NTP 都由管理网内的 OPNsense 就地提供（主机的 DNS/NTP 都指 `10.0.10.1`），管理主机根本不必为这两样直连互联网**，于是「出站到互联网」的必需面收得极干净，基本只剩 HTTPS。

**其二，拒绝入站（在各「下游」接口）。** 互联网→管理网本就被 WAN 默认拒绝 + 无端口转发挡着，无需额外动作。真正要补的是**其它内部网段→管理网**：第一篇给 `SERVER`、`CLIENT` 接口建的是 `源网段 → any` 的放行，而 `any` 把管理网也包含进去了——业务/客户端此刻仍能主动进管理网。

要各加一条 `block`、destination = `MGMT_NET`。这里有个关键、也最容易摆错的地方：

{% note warning %}
**`block` 必须建在「流量进入防火墙的那个接口」上，不是建在管理网（LAN）接口上。** 业务/客户端去打管理网，流量是从 `SERVER` 接口、`CLIENT` 接口**进来**的，所以这两条 block 要分别落在 `SERVER` 接口、`CLIENT` 接口、方向 `in`，且**排在该接口 `→ any` 放行规则之上**（OPNsense 首条匹配）。若错把它们建在 `LAN` 接口、方向 `in`，匹配的是「从管理网进来」的流量，而 source 又是业务/客户端网段，永远匹配不到、等于没建。挂在入口接口入向时，source 用 `MGMT_NET` 取反或直接用 `*` 皆可——进来的本就是本网段流量。
{% endnote %}

无需再加一条显式的「全 block」兜底——OPNsense 接口规则本就有隐式默认拒绝，出站表里没被前面放行命中的、入站没被放行命中的，都会被它拦下。多加一条 destination = `any` 的全 block 反而有风险：一旦位置被挪到放行之上，会把整段流量打死。

这样就形成了刻意的不对称：**管理网能向下够到它管理的网段（规则 2），下游网段却不能向上够到管理网**——管理面只出不进，攻击面最小，而靠有状态连接跟踪，管理网发起的跨段会话回包照常放行。

![](https://img.gulugulublog.com/posts/enterprise-vsphere-lab-04-network/20260625161209330.png)

{% note primary %}
**生产环境对照**：本节这套正是生产里管理网隔离的缩影——入站默认拒绝、出站只放必需目标，且外部依赖（时间、名称解析、补丁/镜像、遥测）尽量走内部源/镜像/代理，访问入口收敛到跳板机或 VPN。我们让出站直连互联网取 HTTPS，已是为实验便利做的让步；更忠实的做法是连这一步也走内部 vLCM 仓库（depot）与出站代理。
{% endnote %}

{% note warning %}
收敛到必需端口的代价，是「按需加规则」：若第八篇 vLCM depot 或别的来源临时要走 `443`/`80` 之外的端口，得回来在规则 3 旁补一条。另外，NTP 的归属会变——现在指 `10.0.10.1`（规则 1 覆盖），第九篇 AD 接管 NTP 后时间源转到业务网的域控，靠规则 2 的跨段放行即可，届时规则 1 里的 `123` 可收掉。
{% endnote %}

**验证**：在任一台 ESXi 上，仍能解析域名、对 `10.0.10.1` 取到 NTP（规则 1）；仍能经 `443` 出网（如 CEIP/在线检查）；管理网 ping 业务网网关 `10.0.40.1` 应通（规则 2 + 有状态回包）。而「业务/客户端→管理网应被拒」这一条，此刻业务网还没主机、不好直接测，可留到第八篇域控就位后自然验证。

## 结语

到这里，砚行物流的业务网络从「每台各扫门前雪」的标准交换机，进阶到了一台集群级的分布式交换机：各业务 VLAN 在 `YX-vDS01` 上一次定义、处处一致，那根挂了三篇的干道 `vmnic1` 也终于扛上了活——而管理网仍稳稳留在原来的标准交换机上，两者并行不悖。顺带，管理网收成了「只出不进、受控出站」的隔离姿态，给整套平台的安全底盘补上了关键一块。

下一篇进入**存储**：用三台主机的本地盘聚合出 vSAN 这套分布式共享存储，并把 vCenter 篇中还寄居在 `esxi01-local` 上的 VCSA，正式 Storage vMotion 迁到 vSAN 上——自举留下的那条临时本地盘，到那时就能回收了。

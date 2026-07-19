---
title: 从零搭建企业虚拟化平台1——实验环境搭建：地址规划、宿主网络与 OPNsense 边界
hidden: true
date: 2026-06-23 10:26:00
categories: [Virtualization, vSphere Lab]
tags: [VMware, ESXi, OPNsense, VLAN]
description: 确定贯穿全系列的网段、VLAN 与命名规划，配置 VMware Workstation 宿主虚拟网络与中继干道，部署 OPNsense 承担出网、网段间路由，以及 AD 上线之前的临时 DNS 与 NTP，为嵌套 vSphere 实验打好网络底座。
---

# 从零搭建企业虚拟化平台1——实验环境搭建：地址规划、宿主网络与 OPNsense 边界

{% note info %}
**📚 从零搭建企业虚拟化平台 · 全系列导航**

- [平台0 · 序章：缘起与全局规划](https://www.catwhiteangel.com/enterprise-vsphere-lab-00-prologue/)
- **平台1 · 环境：OPNsense 与网段搭建　← 本篇**
- [平台2 · 计算：三台嵌套 ESXi](https://www.catwhiteangel.com/enterprise-vsphere-lab-02-esxi/)
- [平台3 · vCenter：部署与建集群](https://www.catwhiteangel.com/enterprise-vsphere-lab-03-vcenter/)
- [平台4 · 网络：vDS 与端口组](https://www.catwhiteangel.com/enterprise-vsphere-lab-04-network/)
- [平台5 · 存储：vSAN 全闪](https://www.catwhiteangel.com/enterprise-vsphere-lab-05-storage/)
- [平台6 · 高可用：HA 与 DRS](https://www.catwhiteangel.com/enterprise-vsphere-lab-06-ha-drs/)
- [平台7 · 身份：AD 域控与 DNS](https://www.catwhiteangel.com/enterprise-vsphere-lab-07-ad-dns/)
- [平台8 · 收尾：时间同步、vLCM 与全系列回顾](https://www.catwhiteangel.com/enterprise-vsphere-lab-08-ntp-wrapup/)
{% endnote %}

序章定下了砚行物流的目标架构，以及「全部实验在一台 64 GB 笔记本上以嵌套方式完成」这一前提。从本篇起进入动手阶段。

地基要先打牢。本篇完成三件事：确定贯穿全系列的地址与命名规划；准备作为最底层（L0）的宿主及其虚拟网络；部署边界设备 OPNsense（`yx-fw01`），由它承担出网、网段间路由，以及在 AD 上线之前临时充当 DNS 与 NTP。本篇结束时，整套实验将拥有一个可路由、可出网、可解析名称的网络底座——后续的 ESXi 与 vCenter 才有立足之地。

{% note info %}
**阅读约定**：提示框用于展开重要概念，警告框用于标注易错点与不可逆操作。文中所有网段、地址、主机名与命令均可直接照抄复现。本篇基于 VMware Workstation Pro 26H1 与 OPNsense 26.1，菜单位置可能随版本略有出入。此外，凡实验环境为简化而偏离真实企业做法之处，将以「生产环境对照」提示框单独标注，说明真实部署会如何取舍——以免把实验室的权宜当作生产范式。这一约定将贯穿整个系列。
{% endnote %}

<!-- more -->

## 1 全局规划：地址与命名

在敲第一条命令之前，先把整套环境的「地理」定下来。这张规划是后续每一篇都会引用的基准，一旦确定就不再变动。

vSphere 的惯例是按功能切分网络流量。vMotion 与 vSAN 若与管理流量挤在同一网段，既互相抢占带宽，也削弱了隔离。六个网段及其用途如下。

| 网段 | VLAN | 子网 | 网关 | 是否路由 |
| --- | --- | --- | --- | --- |
| 管理 Management | 10 | 10.0.10.0/24 | 10.0.10.1 | 是 |
| vMotion | 20 | 10.0.20.0/24 | — | 否（二层隔离） |
| vSAN | 30 | 10.0.30.0/24 | — | 否（二层隔离） |
| 业务 Server | 40 | 10.0.40.0/24 | 10.0.40.1 | 是 |
| 存储 Storage | 50 | 10.0.50.0/24 | — | 否（二层隔离） |
| 客户端 Client | 60 | 10.0.60.0/24 | 10.0.60.1 | 是 |

{% note info %}
**为什么有三个网段不设网关**：vMotion、vSAN 与存储（iSCSI/NFS）都是主机与主机、主机与存储之间的内部通信，不需要跨网段路由，也不应当被路由到别处。将它们设为纯二层、不给网关，既是性能考量，也是安全边界。因此在 OPNsense 上，我们只会为「管理、业务、客户端」三个需要路由的网段创建接口。
{% endnote %}

静态地址分配如下，本系列所有节点均使用固定地址（DHCP 留待 AD 篇，届时由域控统一下发）。

**管理网（10.0.10.0/24）**

| 地址 | 角色 | 主机名 |
| --- | --- | --- |
| .1 | 网关（OPNsense 管理口） | yx-fw01 |
| .5 | 宿主管理地址（Windows 笔记本） | — |
| .11 / .12 / .13 | ESXi 管理口 | yx-esxi01 / 02 / 03 |
| .20 | vCenter Server | yx-vc01 |

**业务网（10.0.40.0/24）**

| 地址 | 角色 | 主机名 |
| --- | --- | --- |
| .1 | 网关 | yx-fw01 |
| .10 | 主域控（AD、DNS、NTP） | yx-dc01 |
| .11 | 辅域控（AD、DNS） | yx-dc02 |
| .20 | 外置存储管理口（TrueNAS） | yx-nas01 |
| .30 | 管理跳板机 | yx-jump01 |

vMotion、vSAN、存储三段的主机地址（各主机的 `.11/.12/.13` 等）将在用到它们的篇章中分配，此处从略。

主机名统一采用 `yx-<角色><序号>` 的形式，完整域名形如 `yx-dc01.corp.yanxing.internal`。AD 林根域为 `corp.yanxing.internal`，NetBIOS 域名为 `YANXING`。选用 `.internal` 而非已被弃用的 `.local`，是因为后者会与 mDNS 冲突，而 `.internal` 已被选定/保留用于私有 DNS 命名空间，不应出现在公共 DNS 根区。

**关于域控的位置，以及为什么 AD 排在后面。** 细心的读者会注意到，两台域控 `yx-dc01`、`yx-dc02` 本身就是虚拟机——它们将运行在我们即将搭建的这套 vSphere 集群之上。这也正是整个系列把身份层（AD）放在平台层（ESXi、vCenter、存储）之后的根本原因：在这套全虚拟实验里，承载域控的平台必须先存在，域控才有立足之处。这是单机全虚拟环境特有的「先有鸡还是先有蛋」——身份基础设施与承载它的平台，是在同一台笔记本上从零一起长出来的。与此同时，vCenter 的部署并不依赖 AD，只依赖正反向 DNS 与正确时间（已由 OPNsense 临时顶上），因此没有任何因素迫使 AD 提前；我们便顺势把它留作后面一个完整的内容（第八篇，AD 与 DNS 合并）。

需要澄清的是，「把域控做成虚拟机」这件事本身在现实中完全成立，且早已是主流——微软自 Windows Server 2012 起便通过 VM-GenerationID 等机制为虚拟化域控提供官方支持。域控负载轻，独占物理服务器并不划算，虚拟化后还能享受高可用与快速重建之便。

{% note primary %}
**生产环境对照**：现实中域控普遍虚拟化，但会刻意把多台 DC 分散到不同的物理宿主、存储乃至站点，并保留一条**不依赖 AD** 的恢复路径——常见做法是留一台物理域控，或确保能绕过 AD 登入虚拟化平台，以免落入「AD 挂掉 → 登不进 vCenter → 无法修复 AD」的循环依赖。此外，持有 PDC 模拟器角色的域控应关闭宿主（VMware Tools）时间同步、只认外部 NTP，避免双时间源打架引发 Kerberos 故障（详见第九篇）。本实验两台 DC 同处一台笔记本、且 vCenter 之上承载着 DC——这恰是生产中要极力规避的单点与循环依赖，仅因实验条件所限而为之。
{% endnote %}

## 2 宿主准备（L0）

{% note warning %}
**动手前的硬性前提**：① 宿主为 64 GB 内存 + NVMe 固态硬盘的 Windows 笔记本；② BIOS/UEFI 中已启用 CPU 虚拟化（Intel VT-x / AMD-V，若有 VT-d 一并开启）；③ 为实验预留至少 400 GB 可用空间。三者缺一，后续都会在某一步卡住。
{% endnote %}

**安装 Workstation Pro。** 自 Broadcom 支持门户下载 VMware Workstation Pro 26H1。该产品现已对包括商业在内的所有用途免费，无需许可密钥，安装后即为完整版。

**处理与 Hyper-V / WSL 的冲突。** 这是笔记本宿主上最容易被忽略、却可能直接卡死整套实验的一点。Windows 上 Workstation 跑虚拟机有两条互斥的底层路径：

- 宿主**没有**启用任何虚拟机监控程序时，Workstation 直接握有 VT-x，能把 `Virtualize Intel VT-x/EPT` 完整透传给 guest——这是嵌套 ESXi **唯一**能用的模式。
- 宿主启用了 Hyper-V、WSL2、内核隔离（Core Isolation / 内存完整性）、Credential Guard、Windows 沙盒等任一项时，Windows 自己的 hypervisor 会占住 VT-x，Workstation 只能改走 Windows Hypervisor Platform（WHP）与之共存。普通虚拟机在这种共存模式下照样能跑（性能略有损耗），**但嵌套硬件虚拟化在这种模式下不被支持**——需要 `Virtualize Intel VT-x/EPT` 的 ESXi 虚拟机会被直接拦下。

```powershell
bcdedit /set hypervisorlaunchtype off
```

重启后生效；需要恢复 WSL 时，再执行

```powershell
bcdedit /set hypervisorlaunchtype auto
```

并重启。同时，在「Windows 安全中心 → 设备安全 → 内核隔离」中关闭「内存完整性」。

{% note danger %}
关闭虚拟机监控程序会**同时停用 WSL2、Hyper-V、Windows 沙盒与凭据保护**。若你日常依赖 WSL2，请将其视为一个需要权衡的开关：要么在实验期间关闭、用完再开，要么接受共存带来的性能折损。请勿在不了解影响的情况下盲目执行。
{% endnote %}

{% note primary %}
**生产环境对照**：真实企业的 ESXi 运行在通过 VMware 兼容性列表（HCL）认证的物理服务器上，配备冗余电源、ECC 内存、带外管理（iDRAC / iLO）以及经认证的存储控制器，并以成对或成组的方式部署，以容忍单机故障。本实验把这一切折叠进一台笔记本上的嵌套虚拟机——正因如此，「关闭 Hyper-V」之类的步骤在真实部署中根本不存在，物理 ESXi 直接独占硬件。嵌套环境足以学习并验证架构与流程，但其性能、稳定性与故障域都不应等同于生产。
{% endnote %}

## 3 宿主虚拟网络

这一节决定了整套实验的网络骨架，务必照抄。我们在 Workstation 中准备三个虚拟网络：

- **VMnet8（NAT，默认已存在）**——作为 OPNsense 的 WAN，借宿主出公网。
- **VMnet2（仅主机 Host-only）**——承载**管理网**（10.0.10.0/24），宿主也接入此网以管理整个实验室。
- **VMnet3（仅主机 Host-only）**——作为承载其余 VLAN 的**中继干道**，宿主不接入。

{% note info %}
**为什么管理网与中继干道分开**：管理网需要让 Windows 宿主直接访问（以打开 OPNsense 与 ESXi 的管理界面），因此它是一个不带标签的扁平网段，宿主在其上拥有一个地址。其余网段（业务、客户端等）则以带 VLAN 标签（802.1Q）的形式共用一根「中继干道」，由 OPNsense 的 VLAN 子接口和后续 ESXi 的虚拟交换机按标签区分。把两者拆到不同的 VMnet 上，可以彻底避开宿主网卡默认地址与网关地址相撞的麻烦，复现起来最稳妥。
{% endnote %}

以**管理员身份**打开 Workstation 的「虚拟网络编辑器（Virtual Network Editor）」，按下表配置：

| 虚拟网络 | 类型 | 子网 | 本地 DHCP | 宿主虚拟网卡 |
| --- | --- | --- | --- | --- |
| VMnet8 | NAT | 保持默认 | 保持启用 | 保持 |
| VMnet2 | 仅主机 | 10.0.10.0 / 255.255.255.0 | **关闭** | **保留** |
| VMnet3 | 仅主机 | 172.31.255.0 / 255.255.255.0 | **关闭** | **取消** |

随后到 Windows 的「网络连接」中，找到「VMware Network Adapter VMnet2」，为其设置静态地址：IP `10.0.10.5`、掩码 `255.255.255.0`、**不填网关**。VMnet3 不需要宿主网卡，故无需配置。

VMnet3 填入的 `172.31.255.0/24` 仅是 Workstation 要求的占位值：它只承载带 VLAN 标签的流量、本身不路由、宿主也不接入，因此这个子网地址实际不起作用，照填即可，不必纠结。

![](https://img.gulugulublog.com/posts/enterprise-vsphere-lab-01-environment/20260623223136006.png)

![](https://img.gulugulublog.com/posts/enterprise-vsphere-lab-01-environment/20260623211538206.png)

{% note warning %}
关闭 VMnet2、VMnet3 的本地 DHCP 非常关键：实验室内的地址全部由我们手工或由 OPNsense 控制，多一个 Workstation 自带的 DHCP 只会制造地址冲突与难查的故障。
{% endnote %}

至于嵌套环境中「内层虚拟机互相不通」这一经典问题，其根源通常与多 MAC 流量经过虚拟交换环境时的二层安全策略有关。若 nested ESXi 跑在物理 ESXi 之上，重点是外层 port group 的 Promiscuous mode / Forged transmits；本系列使用 Workstation 作 L0，具体处理会放到下一篇 ESXi 安装时统一说明。

{% note primary %}
**生产环境对照**：真实企业中，每台 ESXi 至少配备两块物理网卡，分别上联到两台物理交换机，做链路聚合或主备冗余，以容忍单网卡或单交换机的故障；VLAN 由托管交换机的 802.1Q 干道承载，而管理、vMotion、vSAN 往往被分配到彼此独立的物理上联、甚至独立网卡上，以保证带宽与隔离。本实验以单一虚拟网络承载全部流量，不具备任何物理冗余——这是实验室与生产之间最实质的差距之一。读到后续 vDS 与 vSAN 篇时，请记得真实环境里这些流量背后都站着冗余的物理链路。
{% endnote %}

## 4 部署 OPNsense 虚拟机

从 [opnsense.org](https://opnsense.org) 下载当前稳定版的安装镜像（选择 `dvd` 类型、`amd64` 架构）。在 Workstation 中新建虚拟机，要点如下：

- 客户机操作系统：FreeBSD 14 64-bit。
- 内存 2 GB、处理器 2 核、磁盘 16 GB（SCSI）。
- **三块网卡**，依次连接 VMnet8（WAN）、VMnet2（管理 LAN）、VMnet3（中继干道）。
- 载入上面下载的 ISO，启动安装。

![](https://img.gulugulublog.com/posts/enterprise-vsphere-lab-01-environment/20260623150402107.png)

{% note info %}
**关于安装时的内存提示**：本实验仅承担路由、NAT、DNS 与 NTP，2 GB 在轻量负载下通常可以运行；但这低于官方最低/合理规格，若安装器报内存警告、选择 ZFS，或后续启用 IDS/IPS、代理等功能，建议提高到 3–4 GB。若极限压缩内存，也可选择 UFS 以降低开销。
{% endnote %}

安装程序登录账号为 `installer`、密码 `opnsense`；按引导将系统装入磁盘，并设置 `root` 密码。安装完成后移除 ISO 并重启。

重启后进入 OPNsense 控制台菜单，选择「Assign Interfaces」分配接口：

- **WAN** → 连接 VMnet8 的那块网卡，地址方式选 DHCP（由 VMware NAT 自动下发，从而获得公网出口）。
- **LAN** → 连接 VMnet2 的那块网卡，手工设为 `10.0.10.1/24`，**不**在该接口上启用 DHCP。
- 第三块网卡（VMnet3）暂不在控制台分配，稍后在 Web 界面以 VLAN 子接口的形式使用。

{% note warning %}
分配接口时，三块网卡在系统里通常显示为 `vtnet0/1/2` 或 `em0/1/2`，**顺序未必与你在 Workstation 里添加的顺序一致**。请对照各网卡的 MAC 地址（可在 Workstation 的虚拟机设置中查看）逐一辨认，切勿想当然，否则 WAN 与 LAN 接反会导致后续完全无法访问。
{% endnote %}

![](https://img.gulugulublog.com/posts/enterprise-vsphere-lab-01-environment/20260623153758476.png)

![](https://img.gulugulublog.com/posts/enterprise-vsphere-lab-01-environment/20260623154944328.png)

![](https://img.gulugulublog.com/posts/enterprise-vsphere-lab-01-environment/20260623155047854.png)

![](https://img.gulugulublog.com/posts/enterprise-vsphere-lab-01-environment/20260623155127696.png)

## 5 OPNsense 基础配置（Web 界面）

在宿主上用浏览器访问 `https://10.0.10.1`，以 `root` 登录，进入初始向导（`System → Wizard`）。向导分几页，逐页 `Next` 即可：在 `General Information` 填主机名 `yx-fw01`、域 `corp.yanxing.internal`；`Network [LAN]` 确认 `IP Address` 为 `10.0.10.1/24`、`Configure DHCP server` 保持不勾； `Deployment type` 中， `Automatic DHCP/DNS registration` 和 `Optimize for IPsec` 保持不勾。除上述几项外，向导各页一律保持默认，完成后进入主界面。

**创建 VLAN 设备。** 进入 `Interfaces → Devices → VLAN`，点 `+` 新建：`Parent` 选接 VMnet3 的那块网卡（按 MAC 辨认，通常为 `em2`），`VLAN tag` 填 `40`，`Description` 填 `SERVER`，`VLAN priority` 保持默认；`Save` 后再建一条，`VLAN tag` 填 `60`、`Description` 填 `CLIENT`，最后 `Apply`。`Device` 字段留空，系统会自动命名（实际为 `vlan01`、`vlan02`）。vMotion（20）、vSAN（30）、存储（50）不在此创建——它们不路由，等 ESXi 接入这根干道时才用到。

**分配并命名接口。** 进入 `Interfaces → Assignments`，把刚建的两个 VLAN 设备添加为新接口；逐个点开编辑：勾选 `Enable Interface`，`IPv4 Configuration Type` 选 `Static IPv4`，`IPv4 address` 分别填 `10.0.40.1/24`（SERVER）与 `10.0.60.1/24`（CLIENT）。接口的 `Description` 即为其在菜单与列表中的显示名，分别设为 `SERVER` 与 `CLIENT`。`Save` 并 `Apply` 后，在 `Interfaces → Overview` 中即可看到 `SERVER (opt1)`、`CLIENT (opt2)` 两行，各自带正确地址；括号内的 `opt1`/`opt2` 是系统内部标识。

![](https://img.gulugulublog.com/posts/enterprise-vsphere-lab-01-environment/20260623161231658.png)

{% note warning %}
**新建接口默认不放行任何流量。** 除 LAN 外，每个新建接口的防火墙规则默认为空，即「全部拦截」。须到 `Firewall → Rules`，在 `SERVER`、`CLIENT` 两个标签页下各加一条放行规则：`Action` 选 `Pass`、`Direction` 选 `in`、`TCP/IP Version` 选 `IPv4`、`Protocol` 选 `any`、`Source` 选该接口的 `SERVER net` / `CLIENT net`（即本网段）、`Destination` 选 `any`。`Save` 后务必点 `Apply changes` 才会生效——页面标题的 `[new]` 消失即表示已下发。否则这两段既不能上网、也不能互通，且这种「配好了却不通」的故障极难一眼看出。
{% endnote %}

![](https://img.gulugulublog.com/posts/enterprise-vsphere-lab-01-environment/20260623161554639.png)

**确认出站 NAT。** 进入 `Firewall → NAT → Outbound`，默认的 `Automatic` 模式会为所有 RFC1918 私网段做源地址转换，`SERVER`、`CLIENT` 段通常已被覆盖；确认一下即可。

{% note primary %}
**生产环境对照**：本实验让 OPNsense 一肩挑起「边界防火墙」与「网段间路由」两件事（即所谓 router-on-a-stick），这在中小规模或实验室中很常见。但在较大规模的真实企业里，二者通常是分离的：网段间路由由三层核心交换机以完成，而边界防火墙（多为 Palo Alto、Fortinet 等专用设备，并以 HA 双机部署）只负责边界管控。把内部路由压在边界设备上会形成性能与可用性的瓶颈，因此生产环境鲜少如此。
{% endnote %}

**配置 DNS（Unbound）。** OPNsense 默认解析器 Unbound 已启用。进入 `Services → Unbound DNS → Overrides`，在 `Host Overrides` 处为各静态节点添加记录，每条都勾选 `Add PTR record`（本版本中它是每条记录里的独立选项，用于同时生成反向解析）。可现在就把后续要用的几台一并加好：

| Host | Domain | Type | IP address |
| --- | --- | --- | --- |
| yx-fw01 | corp.yanxing.internal | A (IPv4 address) | 10.0.10.1 |
| yx-esxi01 | corp.yanxing.internal | A (IPv4 address) | 10.0.10.11 |
| yx-esxi02 | corp.yanxing.internal | A (IPv4 address) | 10.0.10.12 |
| yx-esxi03 | corp.yanxing.internal | A (IPv4 address) | 10.0.10.13 |
| yx-vc01 | corp.yanxing.internal | A (IPv4 address) | 10.0.10.20 |

随后到 `Services → Unbound DNS → General`，勾选 `Do not register system A/AAAA records` 并 `Apply`。这一步不可省略。

{% note warning %}
**否则主机名会解析到所有接口。** 默认情况下，OPNsense 会把本机主机名（`yx-fw01`）自动注册到它每一个接口的地址上。若不勾 `Do not register system A/AAAA records`，`nslookup yx-fw01` 会同时返回管理口、`SERVER`、`CLIENT`，乃至 WAN 的 NAT 地址——内部域名里混进一个公网侧地址，既不干净、语义也错。勾上之后，主机名只解析到 Host Override 指定的管理口 `10.0.10.1`，正反向都精确。
{% endnote %}

{% note info %}
**正反向解析与 vCenter 的隐藏依赖**：`yx-vc01`（10.0.10.20）这条务必现在就建好，且带 PTR——第四篇部署 vCenter 时，它会校验自身 FQDN 能否被正、反向解析，缺一不可，否则会卡在安装阶段。其余 esxi 三条第三篇即用，一并建了省事。域控（dc01/dc02）位于业务网、且之后由 AD 自己的 DNS 接管，此处先不加。
{% endnote %}

![](https://img.gulugulublog.com/posts/enterprise-vsphere-lab-01-environment/20260623162052694.png)

**配置 NTP。** 进入 `Services → Network Time → General`，启用服务。`Time servers` 保留自带的 `0~3.opnsense.pool.ntp.org` 默认池即可（`Pool` 已勾选），无需改成其它源；建议把第一行的 `Iburst` 勾上，以加快首次同步。`Interfaces` 选 `All (recommended)`，让各内网段都能查询。`Save` 后点右上角启动。后续 ESXi 主机与各节点都将以 `10.0.10.1` 作为临时时间源，直至 AD 篇由域控的 PDC 模拟器接管权威时间。

{% note info %}
**冷启动时满屏 `Not Considered` 是正常反应，不是出错。** 刚启用 NTP 后到 `Services → Network Time → Status` 查看，多半看到所有候选源状态为 `Not Considered`、`Offset` 高达数百毫秒。ntpd 会连续轮询几轮、攒够样本并剔除离群值后，才挑定一个源（状态变为 `Active Peer`，对应 ntpq 里带 `*` 的同步源）。几分钟后刷新，待 `Reach` 升高、出现 `Active Peer` 且其 `Offset` 收敛到毫秒级，即表示同步完成。勾了 `Iburst` 会快很多。
{% endnote %}

{% note primary %}
**生产环境对照**：本实验让 OPNsense 临时承担 DNS 与 NTP，只是为了在 AD 尚未就位时先让平台运转起来。真实企业里，内网 DNS 自始即由 AD 集成 DNS 承担（必要时配合外部权威 DNS，以 split-horizon 方式分离内外解析视图），并不依赖边界防火墙解析内部名称；时间则由可靠的外部源或机房内的 stratum-1 授时设备（如 GPS 授时）逐级下发，域内以 PDC 模拟器为权威。后续 AD 篇会把解析与授时的权威交还给域控，使其回到生产应有的形态——本篇的 OPNsense 方案是过渡，而非范式。
{% endnote %}

至于 DHCP——本阶段所有节点都是静态地址，并不需要它，故暂不配置；它将在 AD 篇随域控一同登场。

## 6 验证与检查点

逐项验证，确保地基无误再往下走。

1. **WAN 与 DNS**：在 OPNsense 的 `Interfaces → Diagnostics → Ping` 中 `ping 1.1.1.1`，再 `ping opnsense.org`。前者通说明出网正常，后者通说明 DNS 解析正常。
2. **网关与接口**：在宿主上打开 `https://10.0.10.1` 能进入界面，且 `ping 10.0.10.1` 通（管理网与宿主同二层直连）。业务、客户端两个网关 `10.0.40.1`、`10.0.60.1` 不在宿主的直连网段内，而宿主未配默认网关，故**默认 ping 不到，这是正常的**；改为在 `Interfaces → Overview` 中确认 `SERVER`、`CLIENT` 两行状态为绿色、各自带正确地址，即证明两个网关已就绪。若确实想从宿主直接 ping 通它们，可临时加两条静态路由（管理员 PowerShell）：`route add 10.0.40.0 mask 255.255.255.0 10.0.10.1` 与 `route add 10.0.60.0 mask 255.255.255.0 10.0.10.1`，这同时也验证了 OPNsense 的网段间路由。
3. **名称解析**：在宿主上执行 `nslookup yx-fw01.corp.yanxing.internal 10.0.10.1`，应**只**解析出 `10.0.10.1`（若返回多个地址，回到上一步勾选 `Do not register system A/AAAA records`）；反向 `nslookup 10.0.10.1 10.0.10.1` 应解析回该域名。
4. **时间同步**：`Services → Network Time → Status` 中出现 `Active Peer`，其 `Offset` 收敛到毫秒级（冷启动需等几分钟）。

![](https://img.gulugulublog.com/posts/enterprise-vsphere-lab-01-environment/20260623164241232.png)

![](https://img.gulugulublog.com/posts/enterprise-vsphere-lab-01-environment/20260623165409200.png)

{% note success %}
**本篇检查点**：① OPNsense 可访问公网并能解析域名；② 宿主可打开 Web 界面、ping 通管理网网关，且 `SERVER`、`CLIENT` 接口在 `Interfaces → Overview` 中状态正常；③ `nslookup` 对 `yx-fw01` 的正、反向解析均成功；④ NTP 已同步。四项全部通过，方可进入下一篇。
{% endnote %}

{% note danger %}
进入下一篇之前，请为 OPNsense 虚拟机拍一个干净快照（命名如 `baseline-clean`）。整套实验运行于单台笔记本之上，是一个不折不扣的单点；养成「每完成一个稳定阶段即快照」的习惯，能在实验出错时以秒级代价回退，而不必从头再来。
{% endnote %}

补充一点：宿主默认只与管理网处于同一二层，可直达 ESXi 与 vCenter 的管理口；若需从宿主直接访问业务或客户端网段（例如远程登录某台域控），可在宿主上添加一条指向 `10.0.10.1` 的静态路由，或通过后续部署的跳板机操作。

```PowerShell
route -p add 10.0.40.0 mask 255.255.255.0 10.0.10.1
route -p add 10.0.60.0 mask 255.255.255.0 10.0.10.1
```

## 结语

至此，砚行物流的实验室已经有了一张可路由、可出网、可解析名称、时间一致的网络底座，边界设备 OPNsense 也已就位。这一篇看似只是「搭网络」，却埋下了后续几篇赖以成立的两块基石——正反向解析与统一时间。

下一篇，我们将在这根干道上安装三台嵌套 ESXi 主机。

---
title: 从零搭建企业虚拟化平台2——计算：三台嵌套 ESXi
hidden: true
date: 2026-06-24 10:42:00
categories: [Virtualization, vSphere Lab]
tags: [VMware, ESXi]
description: 在 VMware Workstation 上安装三台嵌套 ESXi 8.0U3：讲清评估模式与内嵌免费授权镜像的区别（免费版无法接入 vCenter），完成管理网络与主机时间配置，并处理嵌套环境必须放开的二层安全策略。
---

# 从零搭建企业虚拟化平台2——计算：三台嵌套 ESXi

{% note info %}
**📚 从零搭建企业虚拟化平台 · 全系列导航**

- [平台0 · 序章：缘起与全局规划](https://www.catwhiteangel.com/enterprise-vsphere-lab-00-prologue/)
- [平台1 · 环境：OPNsense 与网段搭建](https://www.catwhiteangel.com/enterprise-vsphere-lab-01-environment/)
- **平台2 · 计算：三台嵌套 ESXi　← 本篇**
- [平台3 · vCenter：部署与建集群](https://www.catwhiteangel.com/enterprise-vsphere-lab-03-vcenter/)
- [平台4 · 网络：vDS 与端口组](https://www.catwhiteangel.com/enterprise-vsphere-lab-04-network/)
- [平台5 · 存储：vSAN 全闪](https://www.catwhiteangel.com/enterprise-vsphere-lab-05-storage/)
- [平台6 · 高可用：HA 与 DRS](https://www.catwhiteangel.com/enterprise-vsphere-lab-06-ha-drs/)
- [平台7 · 身份：AD 域控与 DNS](https://www.catwhiteangel.com/enterprise-vsphere-lab-07-ad-dns/)
- [平台8 · 收尾：时间同步、vLCM 与全系列回顾](https://www.catwhiteangel.com/enterprise-vsphere-lab-08-ntp-wrapup/)
{% endnote %}

上一篇把地基打好了：OPNsense（`yx-fw01`）已经在管理网（VMnet2）上提供 DNS、NTP，以及管理 / 业务 / 客户端三段的网关，`esxi01/02/03` 的正反向解析也提前写进了 Unbound。这一篇的任务很具体——在 VMware Workstation 上装出三台**嵌套（nested）** ESXi 主机，配好管理网络与主机时间，让它们具备被 vCenter 纳管的前提。

<!-- more -->

## 1 为什么用「评估模式」而不是「免费版」

先把授权这件事一次说清，免得装错来源、到下一篇加 vCenter 时才发现走不通。

本系列要做集群（vSAN、HA、DRS、vMotion 等），这些能力不能用 Free ESXi license 完成；需要让主机处于 Evaluation Mode，或使用包含相应功能的正式 / 个人实验室用途 license。下载镜像时需要注意：

- Broadcom 现在单独提供一个 **Free ESXi**（免费版）ISO，里面**内嵌了 Free license key**，装完不需要你再输入授权——但这个免费授权**不能被 vCenter 纳管**，也没有 HA / DRS / vMotion / vSAN，并且每台 VM 最多 8 vCPU。更要命的是，从这个内嵌免费授权的镜像装出来的主机，**进不了 Evaluation Mode**，后续加 vCenter 会直接报 `License not available to perform the operation`。
- 只有用**常规 ESXi 安装镜像**（文件名形如 `VMware-VMvisor-Installer-8.0U3*-*.x86_64.iso`）按正常流程安装、且**评估期内不贴任何 license**，主机才会进入 **60 天 Evaluation Mode**，拿到等同 Enterprise Plus 的全功能，能接 vCenter。

所以判定标准不在 ISO 文件名，而在**装完后的授权状态**。装好第一件事就是进 Host Client → `Manage` → `Licensing` 核对：目标状态是 **`Evaluation Mode` / 剩余约 60 天**，**而不是** `VMware vSphere Hypervisor` 这类 Free license。若显示成免费授权，说明用错了下载来源，得换成能进评估模式的安装介质。

**本文实测使用 ESXi 8.0U3j 常规安装镜像；安装完成后，Host Client → Manage → Licensing 显示为 Evaluation Mode。**

![](https://img.gulugulublog.com/posts/enterprise-vsphere-lab-02-esxi/20260624163131239.png)

{% note warning %}
Broadcom 下载门户改版频繁、菜单层级与特殊字符处理都别扭，能不能拿到「常规安装镜像（而非内嵌免费授权的 Free ESXi）」取决于你账号下的授权权益。Broadcom 的下载与授权政策变化很快。对家庭实验室来说，一个相对正规的方向是关注 VMware Certified / VMUG Advantage 相关的 personal-use license：通过 VCP-VVF / VCP-VCF 等认证后，可按当前政策申请个人实验室用途的 vSphere / VCF 授权；VMUG Advantage 则主要提供认证折扣，以及在满足认证条件后访问部分个人用途许可证的资格。具体能拿到哪些产品、期限多长，应以 Broadcom / VMUG 当前页面为准。
{% endnote %}

{% note primary %}
**生产环境对照**：真实环境里授权是正经采购的永久 / 订阅 license，不会指望评估期。评估期或授权到期后，主机会从 vCenter `disconnected`，已开机的 VM 继续运行，但关机后的 VM 无法再开机、也不能新建开机 VM——所以生产里到期前必须换上正式 license。本系列的授权与到期处理，一律以 VMware / Broadcom 当前许可条款为准。
{% endnote %}

## 2 嵌套 ESXi 的硬件画像

在 Workstation 里新建虚拟机时，有一项设置是整篇的命门：**`Virtualize Intel VT-x/EPT or AMD-V/RVI`**。它的作用是把宿主 CPU 的硬件虚拟化能力「透传」进这台 VM，让 VM 里再跑的 ESXi 有本钱去虚拟化更内层的 guest——这正是「嵌套」二字的物理含义。**不勾它，ESXi 能装上，但装好后内层虚拟机一台都开不起来。**

每台 ESXi 的虚拟机规格按下表来。Workstation 的 guest OS 选 `VMware ESX → VMware ESXi 8.x` 后，多数默认值已经合适，但 VT-x/EPT 这一项务必亲手确认。

| 项目 | 取值 | 说明 |
| --- | --- | --- |
| Guest OS | `VMware ESXi 8` | 选对类型后默认走 UEFI、并倾向开启嵌套 |
| Firmware type | `UEFI` | ESXi 8 首选 UEFI；Secure Boot 实验室关掉省事 |
| Processors | 4 vCPU | 最低 2，给 4 留余量 |
| `Virtualize Intel VT-x/EPT` | **勾选** | 嵌套关键，必须亲手确认 |
| Memory | 20 / 12 / 12 GB | 承载 vCenter 的 `yx-esxi01` 多给，见下方内存预算 |
| Disk（启动盘） | 32 GB | vSAN 的缓存 / 容量盘留到存储篇再加 |
| Network Adapter 1 | Custom：**VMnet2** | 管理网，原生不打标签的 VLAN 10 |
| Network Adapter 2 | Custom：**VMnet3** | 中继干道，留给后续 vDS，本篇不配 |

![](https://img.gulugulublog.com/posts/enterprise-vsphere-lab-02-esxi/20260624160040734.png)

{% note warning %}
两块网卡的顺序要记牢：**Adapter 1 → VMnet2（管理）**，**Adapter 2 → VMnet3（干道）**。它们进到 ESXi 里分别是 `vmnic0` 和 `vmnic1`。本篇只用 `vmnic0` 配管理网，`vmnic1` 先挂着不动，等分布式交换机（vDS）那一篇再上场。网卡类型保持默认即可。
{% endnote %}

**关于内存预算**：这是单机嵌套实验最现实的约束。下一篇部署的 vCenter（VCSA，最小的 `Tiny` 规格也要 **14 GB** 内存，低于这个数服务会不稳、频繁 swap、vSphere Client/API 卡顿）会落在 `yx-esxi01` 上，所以三台均分 16 GB 时，那台只剩 2 GB 留给 ESXi 自身，会非常紧。更稳的临时分配是让承载 vCenter 的那台多吃一点：

| 组件 | 内存 | 说明 |
| --- | --- | --- |
| L0 Windows + Workstation | ~10 GB | 宿主自身开销 |
| `yx-fw01`（OPNsense） | 2 GB | 上一篇已建 |
| `yx-esxi01` | 20 GB | 下一篇 vCenter（14 GB）落在它上面 |
| `yx-esxi02` | 12 GB | |
| `yx-esxi03` | 12 GB | |
| 合计 | 56 GB | 余约 8 GB 缓冲 |

{% note warning %}
本篇先按 20 / 12 / 12 起步即可——ESXi 虚拟机的内存随时可以关机后再调。等下一篇 vCenter 部署完、资源压力摸清了，再按实际需要重新分配（例如做 vSAN 时让三台更接近对称）。
{% endnote %}

{% note primary %}
**生产环境对照**：裸金属（bare-metal）服务器上根本没有「勾选 VT-x/EPT」这一步——硬件虚拟化是物理 CPU 与固件的能力，嵌套只是实验室的产物。启动盘在生产里也不会是一块孤零零的虚拟磁盘，而是 BOSS 卡或镜像（mirror）M.2 这类**冗余启动介质**，并由 vSphere Lifecycle Manager（vLCM）以「期望镜像」的方式统一管理生命周期。这里我们用单盘、无冗余，纯为省事。
{% endnote %}

## 3 安装第一台：yx-esxi01

把 ESXi ISO 挂上、虚拟机开机，进入安装程序。这一段几乎没有岔路，照走即可：

1. 引导加载完成后到 `Welcome` 页，回车继续。
2. `End User License Agreement`，按 `F11` 接受。
3. `Select a Disk to Install or Upgrade`，只有一块 32 GB 盘，回车选它。
4. 选键盘布局（`US Default` 即可）。
5. 设置 `root` 密码——实验室中三台可临时共用一套密码、便于操作，但务必记牢；生产环境应使用各自独立的强密码，或纳入集中身份管理。
6. `Confirm Install` 页按 `F11` 开装。
7. 装完提示移除安装介质并重启；在 Workstation 里把 ISO 从 CD/DVD 断开，回车重启。

![](https://img.gulugulublog.com/posts/enterprise-vsphere-lab-02-esxi/20260624162122654.png)

{% note info %}
**装机时这两个「报错」不是报错**

- 安装早期若弹出 `Hardware virtualization is not a feature of the CPU, or is not enabled in the BIOS`——这恰恰是在提醒你 §二 的 `Virtualize Intel VT-x/EPT` 没勾。关机补勾后重来即可。
{% endnote %}

重启后，ESXi 会停在 DCUI（Direct Console User Interface，那块灰黄相间的控制台）。注意：VMnet2 的本地 DHCP 是关掉的（上一篇有意为之），所以这里**不会自动拿到地址**，IP 显示为 `0.0.0.0` 或一个 169 开头的自分配地址，属正常——下一步我们手动配静态。

## 4 配置管理网络（DCUI）

在 DCUI 按 `F2`，用 `root` 和刚设的密码登录，进入 `Configure Management Network`：

- **`Network Adapters`**：确认勾的是 `vmnic0`（对应 Adapter 1 / VMnet2）。两块网卡都在时，只勾 `vmnic0` 作管理上联。
- **`VLAN (optional)`**：**留空**。管理网走的是 VMnet2 上不打标签的原生段，填了反而不通。
- **`IPv4 Configuration`** → `Set static IPv4 address and network configuration`：
  - `IPv4 Address`：`10.0.10.11`
  - `Subnet Mask`：`255.255.255.0`
  - `Default Gateway`：`10.0.10.1`
- **`IPv6 Configuration`**：实验室里直接 `Disable IPv6`，少一层干扰（改这项需重启主机）。
- **`DNS Configuration`** → `Use the following DNS server addresses and hostname`：
  - `Primary DNS Server`：`10.0.10.1`
  - `Hostname`：`yx-esxi01`
- **`Custom DNS Suffixes`**：`corp.yanxing.internal`

按 `Esc` 退出，提示 `Apply changes and restart management network?` 时按 `Y`。

![](https://img.gulugulublog.com/posts/enterprise-vsphere-lab-02-esxi/20260624162948938.png)

进 `Test Management Network`，至少验证两件事：

- `Ping address` 填 `10.0.10.1` 能通——管理网网关可达。
- `Resolve hostname` 能把 `yx-esxi01.corp.yanxing.internal` 解析出来——说明 OPNsense 的 Unbound 记录与本机 DNS 配置都对得上。

![](https://img.gulugulublog.com/posts/enterprise-vsphere-lab-02-esxi/20260624162910139.png)

{% note success %}
**检查点（单机）**：DCUI 顶部显示 `https://10.0.10.11/` 之类的管理地址；`Test Management Network` 中网关可 ping、主机名可解析。满足即可进下一步。
{% endnote %}

## 5 首登 Host Client 与主机时间

在宿主浏览器打开 `https://10.0.10.11/ui`，用 `root` 登录 ESXi Host Client（自签证书的安全警告直接放行）。

第一件事是把时间对齐。时间在后面是硬约束——vCenter 纳管、AD 加域、Kerberos 都对时钟偏差敏感，现在偷的懒后面会变成莫名其妙的认证失败。

`Manage` → `System` → `Time & date` → `Edit NTP settings`：

- `NTP servers`：`10.0.10.1`
- NTP service startup policy：`Start and stop with host`
- 勾选启动并把服务设为运行（`Start`）。
- 在`Manage` → `Services` 里对 `ntpd` 手动 `Start`

回到 `Time & date`，确认 `NTP service` 为 `Running`、时间与真实时间一致。

![](https://img.gulugulublog.com/posts/enterprise-vsphere-lab-02-esxi/20260624163733515.png)

{% note warning %}
`SAVE` 之后如果界面看着像「跳回手动设置」、`NTP service` 仍不是 `Running`，**不是配错了**——是 `ntpd` 还没启动。对话框只写配置、不启服务，启动要去 `Manage` → `Services` 里对 `ntpd` 手动 `Start`。设好 Policy 为 `Start and stop with host` 后，主机重启会随之自起，平时无需再管。
{% endnote %}

{% note info %}
这里让主机直接对 OPNsense（`10.0.10.1`）授时，是**临时**安排。等域控建好后，企业里规范的做法是把时间收敛成一棵层级树：PDC 模拟器对外部权威源、其余成员对内部域。本系列最后一篇会把这套分层授时与 Kerberos 偏差一起收口，届时再把 ESXi 的 NTP 源切过去。
{% endnote %}

## 6 混杂模式解析

**为什么嵌套环境里内层虚拟机会「悄悄」断网？** 设想 vCenter 这台内层 VM 跑在 `yx-esxi01` 里，它有自己的 MAC，记作 MAC-X。它的帧要经过 `yx-esxi01` 的 `vSwitch0`，从上联网卡 `vmnic0` 发出去——而 `vmnic0` 自带的 MAC 是另一个，记作 MAC-L1。问题就在这个不一致上：

- **入向**：发给 MAC-X 的帧到达承载 `yx-esxi01` 的那层虚拟交换环境时，目标 MAC 既不是 `vmnic0` 的 MAC-L1、也不是该端口已知的地址，**默认不会被交付**给 `yx-esxi01`，于是内层 VM 收不到。要让它收到，需要上层开启 `Promiscuous mode`。
- **出向**：内层 VM 以 MAC-X 为源发帧，对上层而言这是「源 MAC 与端口网卡 MAC 不符」的帧，会被当作伪造丢弃。要放行，需要上层 `Forged transmits = Accept`。

整个过程**没有报错、没有日志告警，只是不通**

**真正需要放开的是「承载 nested ESXi 虚拟机的那个外层端口组」，而不是 nested ESXi 自己内部的 vSwitch。**

{% note info %}
**两层要分清**

1. **如果 nested ESXi 跑在物理 ESXi / vCenter 之上**（即 ESXi-on-ESXi）：必须在**外层物理主机**上、承载 nested ESXi 虚拟机的那个 port group 上启用 `Promiscuous mode` 与 `Forged transmits`（必要时加 `MAC address changes`），否则内层多 MAC 的流量会被外层 vSwitch 丢弃。这是 William Lam 那篇经典文章讲的场景，也是大多数人记住的「嵌套要开混杂模式」。
2. **本系列用 VMware Workstation 作 L0**：外层是 Workstation 的 `VMnet2` / `VMnet3`，**没有 vSphere 端口组可配**。Workstation（Windows 宿主）默认就放行这类嵌套流量，所以单个内层 VM 的基本连通往往「开箱即通」，不需要你在外层额外设置。
{% endnote %}

那在 Workstation 拓扑里，我们在 nested ESXi 自己的 `vSwitch0` 上把三项设为 `Accept`，意义何在？**主要是降低实验环境里的二层过滤干扰，并与日后迁到 ESXi-on-ESXi 的习惯保持一致**——它对普通单 MAC 的内层 VM 不是必需，但能为后续虚拟路由器 / 虚拟防火墙、桥接、HA 虚拟 MAC、嵌套迁移等更复杂的二层场景减少干扰。

在 Host Client：`Networking` → `Virtual switches` → `vSwitch0` → `Edit settings` → `Security`，三项设为：

- `Promiscuous mode`：`Accept`
- `Forged transmits`：`Accept`
- `MAC address changes`：`Accept`

其中 `Promiscuous mode` 与 `Forged transmits` 是核心；`MAC address changes` 在普通单 MAC 的 VM 场景下不一定会触发，这里一并放开属**兼容性放宽**，为后续二层场景省心。

![](https://img.gulugulublog.com/posts/enterprise-vsphere-lab-02-esxi/20260624164256998.png)

{% note info %}
**为什么现在就开、而不是等有了内层 VM 再说？** 下一篇一上来就要把 vCenter（VCSA）部署到 `yx-esxi01`，提前在三台 `vSwitch0` 上设好，能避免「装完却联调不顺、回头才想起二层策略」的来回。在 `vSwitch0` 这一层设好，其下端口组默认继承，无需逐个再设。另外，从 vSphere 6.7 起，vDS 提供了 **MAC Learning**，能在不开 Promiscuous mode 的前提下达到同样效果、且没有混杂模式的性能损耗——这是更现代的做法，留到 vDS 那一篇再展开。
{% endnote %}

{% note primary %}
**生产环境对照**：把 `Promiscuous mode / Forged transmits / MAC address changes` 放开，在生产里是一次实打实的**安全降级**——等于允许嗅探与 MAC 伪造，还会带来混杂模式特有的性能损耗（同端口组里每台 VM 都会收到本不属于它的流量副本）。生产默认应保持 `Reject`，只有少数明确场景（嵌套实验、某些 NFV / IDS 旁路）才按需放开，且尽量收窄到具体端口组、优先用 `MAC Learning` 替代。我们这里放开纯属嵌套实验所需，别把这个习惯带去真环境。
{% endnote %}

## 7 复制到 yx-esxi02 / yx-esxi03

第一台跑通后，剩下两台重复同样的流程，只换地址与主机名。

{% note warning %}
**别用「克隆」省这一步。** 直接克隆已装好的 ESXi 虚拟机，会带来重复的 ESXi 系统 UUID 与重复的网卡 MAC，后面组 vSAN / HA 时会冒出难查的灵异问题。ESXi 装机本身很快，老老实实三台各装一遍最干净。真要克隆，也得克隆后重新生成系统 UUID 与 MAC，反而更麻烦。
{% endnote %}

三台的差异参数集中在这张表（其余字段——子网掩码 `255.255.255.0`、网关 / DNS / NTP 均为 `10.0.10.1`、DNS 后缀 `corp.yanxing.internal`、`vSwitch0` 三项安全策略 `Accept`——完全相同）：

| 主机名 | 管理 IP | 管理地址（Host Client） |
| --- | --- | --- |
| `yx-esxi01` | `10.0.10.11` | `https://10.0.10.11/ui` |
| `yx-esxi02` | `10.0.10.12` | `https://10.0.10.12/ui` |
| `yx-esxi03` | `10.0.10.13` | `https://10.0.10.13/ui` |

每台都走一遍 §三 ~ §六：装机 → 核对 `Licensing` 为评估模式 → DCUI 配静态管理网与 DNS → Host Client 设 NTP → `vSwitch0` 放开二层安全策略。

## 8 检查点

三台都配完后，逐项验收：

{% note success %}
1. **三台可达**：`https://10.0.10.11|12|13/ui` 都能用 `root` 登入 Host Client。
2. **授权状态正确**：三台 `Manage` → `Licensing` 均显示 `Evaluation Mode`（剩余约 60 天），而非 Free license——这是下一篇能接 vCenter 的前提。
3. **正反向解析精确**：在任一台 ESXi 的 DCUI `Test Management Network` 里，`Resolve hostname` 能解析自身 FQDN；从宿主或 OPNsense 侧对 `10.0.10.11/12/13` 做反向解析，得到对应的 `yx-esxiNN.corp.yanxing.internal`，且不掺杂其他接口地址。
4. **时间已同步**：三台 Host Client 的 `Time & date` 中 NTP 服务 `Running`，主机时间与真实时间一致。
5. **安全策略就绪**：三台 `vSwitch0` 的 `Security` 三项均为 `Accept`。
6. **嵌套能力就绪**：仅「ESXi 安装完成」并不能证明 VT-x/EPT 已透传——要等下一篇部署 VCSA 或测试 VM 时，内层 VM 能正常 `Power on`，才说明 `Virtualize Intel VT-x/EPT or AMD-V/RVI` 已正确透传。
{% endnote %}

最后强烈建议：在 Workstation 里给三台 ESXi 各拍一个快照，命名 `esxi0N-configured`。这个快照的目的，是保留刚完成安装、网络、DNS、NTP 与安全策略配置后的干净实验状态，方便后续配置失误时快速回滚。授权与评估期的处理，请始终以 VMware / Broadcom 当前许可条款为准。

## 结语

到这里，三台嵌套 ESXi 已经站稳：能登、授权是评估模式、能解析、时间对齐，二层安全策略也提前放开、为内层 VM 铺好了路。它们现在具备了被 vCenter 纳管的全部前提。

下一篇进入 **vCenter 与集群**：把 VCSA 部署到 `yx-esxi01`（`10.0.10.20`，`yx-vc01`），创建数据中心与集群，把三台主机纳管进来。前面在 DNS、时间、二层安全策略上花的功夫，会在那一篇集中兑现成「一次就通」。

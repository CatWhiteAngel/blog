---
title: 从零搭建企业虚拟化平台8——收尾：时间同步、vLCM 镜像与全系列回顾
hidden: true
date: 2026-06-26 15:46:00
categories: [Virtualization, vSphere Lab]
tags: [NTP, w32time, Active Directory]
description: 梳理以 AD 域控为核心的分层时间同步（w32time），复盘 AD CS 证书 NotBefore 落到未来导致 vCenter LDAPS 报错的时钟事故，补讲 vLCM 镜像管理，并以「实验 vs 生产」总差距清单收束全系列。
---

# 从零搭建企业虚拟化平台8——收尾：时间同步、vLCM 镜像与全系列回顾

{% note info %}
**📚 从零搭建企业虚拟化平台 · 全系列导航**

- [平台0 · 序章：缘起与全局规划](https://www.catwhiteangel.com/enterprise-vsphere-lab-00-prologue/)
- [平台1 · 环境：OPNsense 与网段搭建](https://www.catwhiteangel.com/enterprise-vsphere-lab-01-environment/)
- [平台2 · 计算：三台嵌套 ESXi](https://www.catwhiteangel.com/enterprise-vsphere-lab-02-esxi/)
- [平台3 · vCenter：部署与建集群](https://www.catwhiteangel.com/enterprise-vsphere-lab-03-vcenter/)
- [平台4 · 网络：vDS 与端口组](https://www.catwhiteangel.com/enterprise-vsphere-lab-04-network/)
- [平台5 · 存储：vSAN 全闪](https://www.catwhiteangel.com/enterprise-vsphere-lab-05-storage/)
- [平台6 · 高可用：HA 与 DRS](https://www.catwhiteangel.com/enterprise-vsphere-lab-06-ha-drs/)
- [平台7 · 身份：AD 域控与 DNS](https://www.catwhiteangel.com/enterprise-vsphere-lab-07-ad-dns/)
- **平台8 · 收尾：时间同步、vLCM 与全系列回顾　← 本篇**
{% endnote %}

身份立住之后，砚行物流这套平台只剩最后一块地基没夯实：时间。它听起来最不起眼，却在上一篇里以一种很隐蔽的方式咬过我们一口——`yx-dc01` 的 AD CS 在时钟还没同步好时签出的根证书，`NotBefore`（生效时间）落到了未来，等时间校正回来，vCenter 接 LDAPS 直接报「Certificate is not valid」。那其实不是证书的错，是时间的错。这一篇就把时间这件事正经做完：把整套时间层级理顺到 AD 域控上，收回当初在网络篇为管理网主机访问 OPNsense NTP 开的那条放行规则；再补讲一直推迟到收尾才讲的 vLCM 镜像；最后对这套从物理规划一路走到身份与时间的平台，做一次整体回顾和「实验 vs 生产」的总差距清单。这是本系列的最后一篇。

<!-- more -->

## 1 为什么时间是最后一块地基

时间在虚拟化平台里是「隐形的依赖」：平时没人注意，一旦漂了，故障会以各种看不出和时间有关的样子冒出来。上一篇那颗证书的雷是一个例子——表面是证书错误，根子是签发时钟不对。类似的还有很多：Kerberos 认证默认只容忍 5 分钟的时钟偏差，超了域登录就失败；vSAN 对各主机间的时间一致性敏感；vCenter 的 Skyline Health 里专门有一项 `Time is synchronized across hosts and VC`，时间一对不上它就报红。

所以把时间搞稳，不是锦上添花，而是前面所有东西能稳定运行的前提。这也是为什么我们在身份篇里立 dc01 时，就已经抢先把它的时间钉准了（提升域控、装 CA 之前那一步）——那是为了不让证书踩雷。这一篇把当时只做了一半的事补全：当时只配了 dc01 这个 PDC 对外同步，剩下「其余成员、以及 ESXi 和 vCenter 怎么并进这套时间层级」，留到现在。

## 2 Windows 域的时间层级：PDC 对外，成员跟域

先把 Windows 域里的时间规则讲清楚，否则很容易配错。AD 域的时间是一套严格的层级：

- 域里**持有 PDC 模拟器（PDC Emulator）FSMO 角色的那台域控**，是全域的时间权威。在我们这套单域单林里，这台就是 `yx-dc01`。
- 其余所有成员——`yx-dc02`、将来任何加域的服务器——默认都跟着「域层级」要时间，一级一级最终跟到 PDC。这个模式在 `w32tm` 里叫 `NT5DS`。
- 而 PDC 自己头上没有域层级了（它就是顶点），所以**它必须被显式指向一个外部时间源**，否则它会找不到上游、回落到本机 CMOS 时钟自己走。

这一段我们在身份篇已经修好了，这里把命令复述一遍作为时间层级的起点（在 dc01 上，管理员 CMD）：

```
w32tm /config /manualpeerlist:"10.0.40.1,0x8" /syncfromflags:manual /reliable:yes /update
net stop w32time && net start w32time
w32tm /resync /rediscover
w32tm /query /status
```

`/manualpeerlist` 把 PDC 指向外部源、`/reliable:yes` 把它标成全域可靠时间源。外部源填 `10.0.40.1`（OPNsense 在 SERVER 网段的接口，它本身经 WAN 跟公网 NTP 同步），**不填管理网的 `10.0.10.1`**——理由和 DNS 转发器、LDAPS 一样：网络篇的管理网隔离会把 SERVER 网段主动去管理网的流量挡掉。配完 `Source` 应从 `Local CMOS Clock` 变成 `10.0.40.1`、`Stratum` 降到个位数（经 OPNsense 一般是 3~4）。

若 `w32tm /resync` 仍失败，先回 OPNsense 检查 `Services → Network Time → General`，确认 NTP 服务监听了 `SERVER` 接口（或监听 `All`）；同时确认 SERVER 接口规则允许本段访问防火墙自身的 UDP 123。这和身份篇里把 DNS forwarder 改成 `10.0.40.1` 是一个道理——指对了接口，还得那个接口上的服务真在听、规则真放行。

![](https://img.gulugulublog.com/posts/enterprise-vsphere-lab-08-ntp-wrapup/20260626195153405.png)

{% note info %}
**别去「设置」里的时间同步改 PDC，那里改不了。** Windows「设置 → 时间和语言」里的「自动设置时间」「立即同步」，只是 w32time 的浅层封装：能让服务按现有配置同步一次，但改不了同步源、更设不了 `/reliable`、`/syncfromflags` 这些 PDC 专用参数。而且机器加域后，传统 `timedate.cpl` 里的「Internet 时间」页通常直接灰显。判断时间对没对，始终以 `w32tm /query /status` 为准，别信 GUI 那个按钮的脸色。
{% endnote %}

{% note warning %}
**把域控 VM 的「宿主时间同步」关掉，避免和 w32time 打架。** dc01/dc02 是嵌套 ESXi 上的 VM，VMware Tools 可能在某些 VM 操作时把 guest 时间与 ESXi host 对齐，例如恢复快照、挂起恢复、vMotion 之后等。域控上应避免让宿主侧时间同步和 Windows Time Service 同时拉扯：常规的周期性时间同步要关掉，域控时间一律以 w32time 的域层级为准。要留意的是，**即便关了周期性同步，部分 VM 操作仍可能触发一次性校时**——所以域控别频繁回退快照，尤其别在 AD 已经跑起来之后随意单台回滚快照（容易把时间和 AD 状态一起拽乱）。
{% endnote %}

{% note primary %}
**生产环境对照。** 我们这里 PDC 的外部源就一个 `10.0.40.1`（OPNsense），OPNsense 再往公网池要时间，是条又长又单薄的实验室链路。生产里 PDC 通常配多个外部 NTP 源（互相校验、防单点和坏源），讲究的环境还会上真正的 stratum-1 设备（GPS / 原子钟授时）作为内网时间根，而不是把全域时间挂在一台边界防火墙的转发上。
{% endnote %}

## 3 把 ESXi 和 vCenter 的时间也并入

域内时间理顺了，但 ESXi 主机和 VCSA 都不是域成员，它们走的是各自的 NTP 配置。前面几篇里，它们的 NTP 源指的是 OPNsense `10.0.10.1`。这一篇把它们一并切到 AD 域控上，让 AD 成为内网统一的时间权威。

**三台 ESXi 主机**：在 vSphere Client 里，每台 **Host → Configure → System → Time Configuration → Edit**（Network Time Protocol），NTP 服务器填 `10.0.40.10,10.0.40.11`，NTP Service Startup Policy 选 **Start and stop with host**，启动服务。三台都做。

**VCSA（`yx-vc01`）**：在 VAMI（`https://10.0.10.20:5480`）→ **Time → Time synchronization**，模式选 **NTP**，服务器填 `10.0.40.10,10.0.40.11`。注意 VCSA 的时间要么走 NTP、要么走 Host（从 ESXi 同步），**二选一别同时开**；这里选 NTP 直连域控，逻辑最清楚。

![](https://img.gulugulublog.com/posts/enterprise-vsphere-lab-08-ntp-wrapup/20260626195500920.png)

![](https://img.gulugulublog.com/posts/enterprise-vsphere-lab-08-ntp-wrapup/20260626195701786.png)

{% note warning %}
**又是那条「反方向」的跨网段口子，别漏。** ESXi 和 VCSA 在管理网（VLAN10），域控在 SERVER 网（VLAN40）。它们去域控同步时间，走的是 **MGMT → SERVER 的 UDP 123**——这是管理网主动访问 SERVER 网段，方向和网络篇做的「下游不准访问管理网」隔离相反，和身份篇里 DNS 的 53、LDAPS 的 636 是同一类容易漏的反向开口。需要在 OPNsense 上确认放行 `MGMT_NET → DC UDP 123`。
{% endnote %}

切完之后，ESXi/VCSA 不再向 `10.0.10.1` 要时间了，于是可以**收回网络篇当初为它们在管理隔离里开的那条 123 放行**（呼应网络篇的口子）。但收的时候看清楚：要收的是「管理网设备 → OPNsense `10.0.10.1` 的 123」这条；**别误删 PDC 经 `10.0.40.1` 出去的那条**——dc01 还靠它对外同步，删了 PDC 就又回落 CMOS 了。

{% note primary %}
**生产环境对照，以及一个嵌套实验室特有的取舍。** 把 ESXi/VCSA 的时间指向 AD 域控，是「AD 作为内网唯一时间权威」的标准企业形态，所以我们默认这么做。但在我们这套**全嵌套**实验室里，它有个隐含的软循环依赖：两台 DC 是跑在这三台 ESXi 上的 VM，而 ESXi 又把时间源指向这些 DC-VM。整套冷启动时，ESXi 先用本机时钟跑、等 DC VM 起来后再收敛，不致命，但确实是个环。

生产里这个环不存在，因为域控跑在独立的管理基础设施上（见身份篇那条「DC 别和工作负载挤一个集群」）。如果你想在实验室里也彻底避开这个环，有个更稳的变体：让 ESXi/VCSA 继续指向 OPNsense `10.0.40.1`（它是 L0 上的独立 VM、不在嵌套集群里，无循环），只让 Windows 域跟 PDC——这样所有时钟最终都锚定到 OPNsense → 公网池这一个外部源。选这个变体的话，上面那条 OPNsense 123 规则就别收回、保留即可。
{% endnote %}

## 4 验证时间已对齐

把时间这块该绿的都绿一遍：

- **域内**：dc01 上 `w32tm /query /status` 的 `Source` 是 `10.0.40.1`、`Stratum` 个位数；dc02 及任何成员上 `Source` 指向 dc01（域层级）。在任一 DC 上 `w32tm /monitor` 能看到全域各 DC 的 offset 都很小。
- **ESXi**：每台 Time Configuration 显示 NTP 服务 running、时间一致；命令行可 `esxcli system ntp test`（或看 `esxcli system time get`）确认在跟 DC 走。
- **VCSA**：VAMI Time 显示已同步。
- **Skyline**：vCenter 的 Skyline Health 里 `Time is synchronized across hosts and VC` 一项转绿——这是时间真正对齐的权威信号。

![](https://img.gulugulublog.com/posts/enterprise-vsphere-lab-08-ntp-wrapup/20260626200037979.png)

{% note success %}
**时间这块地基夯实了。** 从 PDC 对外、域成员跟域、到 ESXi/VCSA 并入同一权威，全平台的时钟现在有了统一的来源。回头看身份篇那颗证书的雷——只要先把这一步做在前面，那颗雷根本不会埋下。这也正是为什么我们在立 dc01 时就抢先钉了时间：时间是地基，得先浇。
{% endnote %}

## 5 补讲 vLCM 镜像：一直推迟到收尾的那块

前面 vCenter 篇、存储篇都把 vLCM（vSphere Lifecycle Manager）推到了收尾才讲，现在补上。它管的是「怎么把整个集群的 ESXi 软件栈保持一致、并统一升级」。

**两种模式，以及为什么只剩一条路。** vLCM 有两种管理方式：老的 **baselines**（基线，前身是 vSphere Update Manager / VUM，逐台打补丁的命令式做法）和新的 **Images**（镜像，声明式地定义「这个集群所有主机都应该长成这个样子」）。版本现实很清楚：vSphere 8.0 起 baseline 已被弃用、新建集群默认就是镜像模式；到 vSphere 9.0，用 baseline 升级集群/主机被弃用，仍在用 baseline 的集群**必须先转成镜像**才能升级到 9.x。所以镜像是前进的唯一方向，baseline 只是过渡期的遗留。

**一张镜像由什么组成。** base image（ESXi 版本本身，唯一必填项）+ vendor add-on（OEM 厂商的驱动/补丁集合）+ firmware-and-drivers add-on（固件与驱动，**需要硬件厂商的 hardware support manager 插件**）+ 若干 components（第三方驱动/组件）。镜像把这一整套钉成一个「期望状态」，集群里每台主机都按它对齐。

**操作（Cluster → Updates → Image）。** 进集群的 Updates → Image：如果它提示你 Setup Image，说明这个集群当前还是 baseline 管理的。8.0U3 起转镜像很省事——不用自己导 ISO 或拼镜像，可以直接采纳「集群里某台主机上已经装着的镜像」（Get Installed Images），Finish Image Setup，跑一次合规检查，再 Remediate。

![](https://img.gulugulublog.com/posts/enterprise-vsphere-lab-08-ntp-wrapup/20260626201110309.png)

**滚动修复（rolling remediation）。** 修复时主机**一台一台来**：当前主机进维护模式，DRS/vMotion 把上面的 VM 疏散到别的主机（靠我们 HA 篇启用的 Fully Automated DRS 自动完成），打补丁/升级、按需重启，再轮到下一台——全程集群对外不停服。Quick Boot 能跳过固件自检加速重启；8.0U3 的 LivePatch 还能让部分修复免重启免疏散。注意 vLCM 的合规校验和修复**依赖 DNS 解析和网络连通**——这正好是我们身份篇刚理顺的东西，算是前面几篇给这一步铺好了路。

不过在本实验这套 64 GB 宿主、30/12/12 GB 的紧配置下，别把「滚动修复不停服」理解成必然能实操成功——这和 HA 篇里「VCSA 自我保护在本实验只是概念」是同一类资源现实。`yx-esxi01` 给了 30 GB（含 VCSA + vSAN），esxi02/03 各 12 GB，而 VCSA Tiny 要 14 GB：一旦 vLCM 要修复的恰好是承载 VCSA 的那台主机，其它两台未必接得住 14 GB 的 VCSA，DRS/vMotion 疏散就会失败，remediation 也无法无中断完成。所以本篇主要演示 vLCM Image 的**概念、合规检查与流程**；真要执行 remediation，先确认 VCSA 和其它 VM 都能被迁走（或临时把目标主机内存调高、把非必要 VM 关掉腾位）。

{% note warning %}
**baseline → 镜像是单向门，转之前想清楚。** 一旦把某个集群从 baseline 切到镜像，就不能再切回 baseline 了（只能把主机移出到另一个 baseline 集群）。这和评估版 DC 不能转正式版是一个性质的单向操作——不是坏事（镜像本来就是该去的方向），但要知道这扇门没有回头路。
{% endnote %}

![](https://img.gulugulublog.com/posts/enterprise-vsphere-lab-08-ntp-wrapup/20260626200845666.png)

{% note danger %}
**固件那半，嵌套环境演不出，诚实标注。** 镜像里的 firmware-and-drivers add-on 要靠 hardware support manager 插件去对接真实服务器的带外管理（iDRAC / iLO / BMC）才能更新固件。我们这套是**嵌套 ESXi**，底下没有真实固件层、也没有 HSM 可装，所以「用 vLCM 统一纳管固件」这半**在本实验室不可复现**。
{% endnote %}

{% note primary %}
**生产环境对照。** 生产会把 vendor depot + HSM 接进来，让固件和 ESXi、驱动一起进入同一份声明式镜像，一次修复把「软件 + 固件」全对齐到期望状态；多集群则用统一镜像保证跨集群的主机同构。另外 vSphere 9 文档里 ESXi 已改称 ESX，升级到 9.x 前必须先把 baseline 集群转成镜像——这条和身份篇说的「升 9.0 前必须先退出 IWA 域」一样，都是规划升级时要提前扫掉的前置障碍。
{% endnote %}

## 6 全系列收尾：砚行物流这套平台回头看

到这里，砚行物流的虚拟化平台从无到有走完了一整条路：从序章的物理与网段规划，到用 OPNsense 把边界和各 VLAN 立起来（环境篇），装三台嵌套 ESXi（ESXi 篇），部署 vCenter 建集群（vCenter 篇），用 vDS 把网络收口（网络篇），用 vSAN 把三台的本地盘聚成共享存储（存储篇），开 HA/DRS 让它能自愈和均衡（HA 篇），立 AD 域控把身份和 DNS 统一（身份篇），最后把时间层级理顺（本篇）。计算、网络、存储、高可用、身份、时间——一套企业虚拟化平台该有的地基，齐了。

这套平台的价值在于「能完整复现一遍企业级架构的搭建逻辑」，但它终究是跑在一台 64 GB 笔记本上的全嵌套实验室。哪些地方是为了能在单机上跑而做的妥协、真要上生产该补什么，这份清单值得收拢成一处——它也是贯穿全系列那些「生产环境对照」框的总账：

{% note primary %}
**「实验 vs 生产」总差距清单。**

- **物理冗余**：单宿主、全嵌套，没有任何物理层冗余；宿主一断电全平台没。生产要多物理主机、多机架乃至多站点。
- **内存**：30/12/12 GB 贴边硬撑，靠错峰开机、关测试机腾挪。生产按工作负载留足余量 + N+1。
- **网络冗余**：每台 ESXi 单上行 vmnic，用 `das.ignoreRedundantNetWarning=true` 压掉告警。生产要双网卡、双上行、双交换机。
- **管理与工作负载未分离**：DC 和工作负载挤在同一个 `YX-Cluster01`（鸡生蛋耦合）；两台 DC 还可能落在同一宿主（逻辑冗余非物理容错）。生产分离管理集群、用反亲和把 DC 拆到不同故障域。
- **管理入口**：全程用宿主机（那台 Windows 笔记本）裸连去管 ESXi/vCenter/域控，等于拿一台"什么都干"的机器当土跳板——身份篇补的 `yx-jump01` 是个加域的跳板示例，但仍是按需开关的简化。生产里管理入口是一台专职堡垒机（bastion）：唯一入口、强认证 MFA、会话录像与命令审计，内部资产只接受来自它的连接——这在等保/ISO 27001/PCI-DSS 里常是强制项，云上也原样保留（Azure Bastion、AWS Session Manager 等）。
- **PKI / 身份**：LDAPS 证书来自域控上顺手装的企业根 CA（非独立离线 PKI）；身份用 AD over LDAPS（生产可上联合身份 + MFA + 条件访问）。
- **固件层缺失**：嵌套没有真实固件，vLCM 的 HSM/固件纳管演不出；vSAN 虽是 OSA 全闪，但底层不是 HCL 认证硬件。
- **vCenter / 准入**：单台 VCSA、无 VCHA（Active/Passive/Witness）；HA 准入控制只留 1 台容量（生产按 N+1 留）。
- **时间链路**：PDC → OPNsense → 公网池这条单薄链（生产用多源、独立授时基础设施）。

真要把这套搬向生产，要补的就是这份清单的反面：物理与网络冗余、管理与工作负载分离、专职堡垒机作为唯一管理入口、独立 PKI、VCHA、固件纳管、完整的监控告警与备份体系。
{% endnote %}

把这些差距列清楚，不是给实验室泼冷水，而是让它的价值落到实处：你在这台笔记本上踩过的每一个坑——证书的时间雷、跨网段那些反方向的防火墙口子、PDC 回落 CMOS、嵌套的循环依赖——到了真实生产里都还会以更高的代价重现，而你已经知道它们长什么样、根在哪里。这套平台真正留下的，不是那几台虚拟机，是这份「知道会在哪卡住」的经验。

砚行物流的平台到此就算立住了。从一张网段规划图开始，到现在计算、网络、存储、高可用、身份、时间一层层叠完——这趟从零到一的搭建，就到这里。

{% note success %}
**全系列完结。** 感谢一路看到这里。
{% endnote %}

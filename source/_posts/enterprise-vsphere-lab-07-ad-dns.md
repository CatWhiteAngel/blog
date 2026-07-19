---
title: 从零搭建企业虚拟化平台7——身份：Active Directory 域控与 DNS 整合
hidden: true
date: 2026-06-25 19:08:00
categories: [Virtualization, vSphere Lab]
tags: [Active Directory, DNS, Windows Server]
description: 部署一对冗余域控建立 AD 域，由 AD 集成 DNS 接管内网权威解析并与 OPNsense 完成解析权交接，再将 vCenter 以外部身份源方式接入 AD，替代单一 administrator@vsphere.local 账号的管理模式。
---

# 从零搭建企业虚拟化平台7——身份：Active Directory 域控与 DNS 整合

{% note info %}
**📚 从零搭建企业虚拟化平台 · 全系列导航**

- [平台0 · 序章：缘起与全局规划](https://www.catwhiteangel.com/enterprise-vsphere-lab-00-prologue/)
- [平台1 · 环境：OPNsense 与网段搭建](https://www.catwhiteangel.com/enterprise-vsphere-lab-01-environment/)
- [平台2 · 计算：三台嵌套 ESXi](https://www.catwhiteangel.com/enterprise-vsphere-lab-02-esxi/)
- [平台3 · vCenter：部署与建集群](https://www.catwhiteangel.com/enterprise-vsphere-lab-03-vcenter/)
- [平台4 · 网络：vDS 与端口组](https://www.catwhiteangel.com/enterprise-vsphere-lab-04-network/)
- [平台5 · 存储：vSAN 全闪](https://www.catwhiteangel.com/enterprise-vsphere-lab-05-storage/)
- [平台6 · 高可用：HA 与 DRS](https://www.catwhiteangel.com/enterprise-vsphere-lab-06-ha-drs/)
- **平台7 · 身份：AD 域控与 DNS　← 本篇**
- [平台8 · 收尾：时间同步、vLCM 与全系列回顾](https://www.catwhiteangel.com/enterprise-vsphere-lab-08-ntp-wrapup/)
{% endnote %}

到这一篇为止，砚行物流的平台已经把计算、网络、存储、高可用都铺好了，但有一件事一直没动：到现在为止，能登进 vCenter 的只有一个账号——`administrator@vsphere.local`。这是 SSO 内置域里的本地账号，既不是「公司账号」，也没法和文件服务器、其他系统共用同一套身份。这一篇就把这块补上：在 `YX-Server`（VLAN40）立起一对冗余域控，建域 `corp.yanxing.internal`，把内网的权威 DNS 交给 Active Directory，再把 vCenter 以外部身份源的方式接进来。立完之后，`YX-Server` 端口组也终于迎来它第一批正式住户。

<!-- more -->

## 1 为什么先立域：从 administrator@vsphere.local 说起

`administrator@vsphere.local` 能用，但它是个「孤岛账号」。它只活在 vCenter 自带的 SSO 域里，离开 vCenter 谁都不认；想给同事分权，要么共享这一个超级账号（审计噩梦），要么在 SSO 本地域里一个个手建用户。真实企业不会这么干——身份要有一个统一的、可审计的、能跨系统复用的来源，这个来源在 Windows 生态里几乎默认就是 Active Directory（活动目录，AD）。

把 AD 立起来之后，vCenter 不再自己管人，而是把「这个人是谁、密码对不对、属于哪个组」这件事外包给 AD；vCenter 只负责「这个组能在 vSphere 里做什么」。账号的增删改、离职禁用、组成员调整，全在 AD 那一侧完成，vCenter 这边的权限规则基本不用动。这就是「身份源（identity source）」的价值。

这里有一个必须先讲清楚的版本现实，它直接决定了我们这一篇的接入方式怎么选。历史上 vCenter 接 AD 有两条路：一条是把 vCenter 这台 VCSA 真正加入 AD 域（Integrated Windows Authentication，IWA，域加入法），另一条是不加域、只把 AD 当成一个外部 LDAP 目录来查询（AD over LDAP）。

{% note info %}
**IWA 已经是「将死」的路，别再往上走。** Broadcom 已宣布 IWA（域加入法）弃用，并在 vSphere 8.0U3 之后的首个大版本——也就是 vSphere 9.0——正式移除：届时 vCenter 不再支持以 IWA 加入 AD 域。8.0/8.1 里 IWA 选项还在，纯粹是向后兼容。官方现在的推荐是 **AD over LDAP，且强烈建议走 LDAPS（带 SSL 的 LDAP）**。所以本篇从一开始就按 AD over LDAPS 写，不演示域加入。
{% endnote %}

这一篇的落地顺序是：先立第一台域控 `yx-dc01` 并建出新林新域，把 AD 集成 DNS 顺势起来；再做 DNS 整合（这是和现状衔接最关键的一步）；然后加第二台域控 `yx-dc02` 做冗余；最后把 vCenter 以 AD over LDAPS 身份源接进来，用域账号验证登录。

{% note warning %}
**先看内存预算，再动手。** 宿主是 64 GB，现在的占用是 esxi01=30 GB（含 VCSA + vSAN）、esxi02/03 各 12 GB，再加 OPNsense 和宿主本身，已经贴边。这一篇要在集群里新增两台域控（默认每台 4 GB），等于再吃约 8 GB。动手前建议：把 HA 篇建的测试机 `yx-test01` 关掉腾内存。
{% endnote %}

## 2 部署第一台域控 yx-dc01

### 2.1 选 ISO 与建虚拟机

操作系统用 **Windows Server 2025 Standard 评估版（Desktop Experience，带图形界面）**。评估版从 Microsoft Evaluation Center 下载，评估期 180 天，且可以 rearm（重置评估计时）最多 6 次、累计接近 3 年，对实验室完全够用；带 Desktop Experience 是为了有完整 GUI，方便截图和用 Server Manager 点配置。下回来的 ISO 可以上传到 vSphere Content Library；如果前面几篇没有单独建过 Content Library，也可以直接把它放进 `vsanDatastore` 下的一个 ISO 目录，或在新建 VM 时从本地客户端临时挂载 ISO。下面的截图按 Content Library 路线演示，但它不是本篇的硬性前提，三条路任选其一即可。

{% note warning %}
**评估版有个一旦踩到就回不了头的坑：已经提升为域控的评估版服务器，不能再转换成正式版（Retail）。** 也就是说，如果你打算以后给这台机器上正式 license，得在「提升为域控之前」就用产品密钥把版本转好（`DISM /online /Set-Edition:ServerStandard /ProductKey:xxxx`）。实验室里我们就吃 180 天评估 + rearm，不转正式版，所以不受影响——但要知道这条单向门在哪（真要上正式版，只能另建一台正式版 DC、把 FSMO 角色迁过去、再退掉这台评估版 DC）。另外评估版按微软规则需要在装好后较短时间内联网激活一次以免自动关机，隔离实验室记得放它出网一次或安排好 rearm。
{% endnote %}

VM 规格：2 vCPU、4 GB 内存、60 GB 精简置备磁盘、固件选 **UEFI**（和我们其他较新的 VM 一致；嵌套环境里 Secure Boot 可开可不开）。网络挂到 vDS 的 **`YX-Server`**(VLAN40) 端口组——这是 VLAN40 的第一台正式住户。

![](https://img.gulugulublog.com/posts/enterprise-vsphere-lab-07-ad-dns/20260625234300771.png)

{% note primary %}
**生产环境对照。** 真实生产里，域控几乎不会和它要去认证的工作负载挤在同一个集群里——那会形成「鸡生蛋」的依赖：集群要靠 AD 认证管理员，AD 又跑在这个集群上。生产通常把域控放在独立的管理基础设施（专门的管理集群、甚至独立物理机/不同站点）上，和工作负载集群在故障域上分开。我们这套全嵌套实验室是把两台 DC 直接当作 `YX-Cluster01` 里的 VM 来跑，属于实验室的刻意妥协，方便也省机器，但要清楚这在生产里是要避免的耦合。
{% endnote %}

### 2.2 装系统、配静态网络

装完系统、设好本地 Administrator 密码后，先把这台机器从随机机器名改成有意义的名字 `yx-dc01`（提升域控前改名最省事，提升之后再改名会牵动一堆注册记录），然后配静态网络：

- IP：`10.0.40.10`，掩码 `/24`，网关 `10.0.40.1`（VLAN40 是路由段，网关在 OPNsense 上）
- 首选 DNS：**先指向自己**，即 `127.0.0.1`（提升为域控、AD 集成 DNS 起来之前，它先用本机回环占位；提升之后我们再来调整 DNS 指向）

![](https://img.gulugulublog.com/posts/enterprise-vsphere-lab-07-ad-dns/20260626001046195.png)

网络配好后、**提升域控和装 CA 之前，先把这台机器的时间对齐**——这是个必须排在前面的步骤，不是可选项（原因见 2.4：CA 会把签发时的时钟写进证书，时间不对会埋下延迟爆雷）。这台将来要当 PDC 模拟器、是全域的时间权威，所以让它直接跟外部 NTP 同步。管理员 CMD：

```
w32tm /config /manualpeerlist:"10.0.40.1,0x8" /syncfromflags:manual /reliable:yes /update
net stop w32time && net start w32time
w32tm /resync /rediscover
w32tm /query /status
```

NTP 源填 `10.0.40.1`（OPNsense 在 SERVER 网段的接口，本身跑着 NTP），别填管理网的 `10.0.10.1`——理由和前面 DNS 转发器一样，管理网隔离会把 SERVER 网段过去的流量挡掉。`/query /status` 里 `Source` 应从 `Local CMOS Clock` 变成你填的源、`Stratum` 降到个位数，才算对齐。时间层级的完整收尾（PDC 对外、其余成员跟域层级）留到平台8 讲，这里先把 dc01 的时间钉准，给后面装 CA 铺路。

### 2.3 装 AD DS 角色、提升为新林新域

打开 **Server Manager → Add roles and features**，在 Server Roles 一步勾上 **Active Directory Domain Services**（会弹「Add features required」一并装上）。这一步我们暂时不用单独去勾 DNS Server 角色——升级为新林新域时，向导会自动把 AD 集成 DNS 一起装起来。装完角色后，Server Manager 右上角的旗标里会出现一条「Promote this server to a domain controller」，点它进提升向导。

提升向导的关键选项：

- **Deployment Configuration**：选 **Add a new forest（添加新林）**，Root domain name 填 `corp.yanxing.internal`。
- **Domain Controller Options**：Forest / Domain functional level 都选 **Windows Server 2025**（全新林、没有旧 DC 要兼容，直接拉到最高）；勾选 DNS server（默认就勾着）；设 **DSRM**（目录服务还原模式）密码并记牢——这是日后 AD 出问题时进还原模式用的，和域管理员密码是两回事。
- **Additional Options**：确认 **NetBIOS 域名** 是 **`YANXING`**（向导一般会从 `corp` 自动取，注意核对成我们锁定的 `YANXING`，别让它默认成 `CORP`）。

![](https://img.gulugulublog.com/posts/enterprise-vsphere-lab-07-ad-dns/20260626002104235.png)

![](https://img.gulugulublog.com/posts/enterprise-vsphere-lab-07-ad-dns/20260626002210981.png)

{% note info %}
**为什么域名用 `corp.yanxing.internal` 这种「带子域 + 不可路由后缀」的写法。** 一是 SSO 本地域是 `vsphere.local`，AD 域名必须和它不同，否则后面 vCenter 接入会冲突报错；二是用 `.internal` 这种保留后缀（而不是真实拥有的 `yanxing.com`）能避免和公网同名域撞车，是内网域命名的常见稳妥做法；三是带一层 `corp.` 子域，给未来可能的多域/子域结构留出空间。这套命名我们在系列最开始就锁死了，这里只是兑现它。
{% endnote %}

点 Install，向导跑完会自动重启。重启后登录界面会变成显示域名 `YANXING\Administrator`，说明这台已经是域控了。AD 集成 DNS 也随之起来：打开 **DNS Manager**，你会看到正向查找区域里多了 `corp.yanxing.internal`，里面已经自动注册了一堆以下划线开头的 SRV 记录（`_ldap`、`_kerberos` 等），这些是域成员用来定位域控的「路标」。

![](https://img.gulugulublog.com/posts/enterprise-vsphere-lab-07-ad-dns/20260626003214489.png)

{% note success %}
**这是正常现象，不是装错了。** 第一次开 DNS Manager 看到 `corp.yanxing.internal` 区域里塞满 `_msdcs`、`_sites`、`_tcp`、`_udp` 这些下划线节点和一堆 SRV/A 记录，是 AD 提升时自动注册的服务定位记录，AD 全靠它们工作，别手痒去删。能在区域里看到 `yx-dc01` 的 A 记录、并且 `nslookup yx-dc01.corp.yanxing.internal` 能解析出 `10.0.40.10`，这一步就成了。
{% endnote %}

### 2.4 启用 LDAPS（在 dc01 上装 AD CS 企业根 CA）

{% note danger %}
**装 CA 之前必须先确认 dc01 的时间已同步正确，否则会埋一颗延迟到第 5 节才炸的雷。** CA 签证书时会把当时的系统时钟写进证书的 `NotBefore`（生效起始时间）。若此刻 dc01 还吊在偏快的 CMOS 时钟上（NTP 没同步好时的典型状态），签出的证书 `NotBefore` 会落到未来；等时间校正回来，vCenter 接 LDAPS 时就会报「Certificate is not valid: NotBefore …」。正确顺序是先把时间搞稳再装 CA：先在 dc01 上 `w32tm /query /status` 确认 `Source` 不是 `Local CMOS Clock`、`Stratum` 为个位数，再往下做。
{% endnote %}

后面 vCenter 接 AD 推荐走 LDAPS（636 端口、SSL 加密），而 LDAPS 需要域控上有一张服务器证书。最省心、也最贴近生产做法的办法，是在 `yx-dc01` 上装一个轻量的 **AD CS（Active Directory Certificate Services）企业根 CA**：企业根 CA 装好后，域控会通过自动注册拿到一张可用于 LDAPS 的域控证书，636 端口随即可用，不用手工折腾证书申请。

在 Server Manager 里 Add roles and features 勾上 **Active Directory Certificate Services**，角色服务选 **Certification Authority**；装完后在通知旗标里点「Configure Active Directory Certificate Services」，CA 类型选 **Enterprise → Root CA**，其余走默认即可。配好后等域控自动注册到证书（或重启一次域控触发），LDAPS 就通了。

验证 636 是否在监听、证书是否就位，可以在 dc01 上用 `ldp.exe`（自带工具）连本机 636 端口，能成功绑定即说明 LDAPS 可用。

**导出根 CA 证书备用（5.2 接 vCenter 要用）。** vCenter 信任的是签发链的根，所以导**根 CA 证书**而不是某台 DC 的证书——这样日后 DC 的 LDAPS 证书续期，vCenter 端不用重配。在 dc01 上管理员 CMD 一条命令导成 Base64：

```
certutil -ca.cert C:\yx-rootca.der
certutil -encode C:\yx-rootca.der C:\yx-rootca.cer
```

要点：**格式必须是 Base64（PEM 文本，以 `-----BEGIN CERTIFICATE-----` 开头），不要 DER**（vCenter 上传 DER 会报格式错，导完用记事本打开能看到 BEGIN CERTIFICATE 即对）；**只导公钥证书、绝不导私钥**。导完把 `yx-rootca.cer` 拷到操作 vSphere Client 的那台机器上（VLAN40 可达的话走网络共享 `\\10.0.40.10\c$`（记得在宿主机加路由），或干脆把这段 Base64 文本复制粘贴过去另存即可——证书公钥不是机密）。

{% note primary %}
**生产环境对照。** 我们这里是「在域控上顺手装个企业根 CA 自签 LDAPS 证书」，是实验室的简化路径。生产环境的 LDAPS 证书来自规范的企业 PKI（独立的离线根 CA + 在线从属 CA、模板化签发、有完整的轮换和吊销流程），而不是把 CA 角色和域控堆在一台机器上。把 PKI 和域控分开、把根 CA 离线，是生产里的基本盘。
{% endnote %}

{% note info %}
**不想装 AD CS 的降级方案，以及它的代价。** 技术上 vCenter 也能用纯 LDAP（389 端口、不加密）接 AD。但要知道：微软近年把 AD 的默认行为收紧为要求 LDAP 签名 / 通道绑定（参见 ADV190023），未签名的明文 LDAP 越来越容易被域控直接拒绝；而且 389 明文会把查询账号的口令暴露在网络上。在我们这套完全隔离的实验室里，纯 LDAP 大概率能跑通，但它是「能用」不是「该用」。本篇正文按 LDAPS 走。
{% endnote %}

## 3 DNS 整合：把 corp.yanxing.internal 的权威交给 AD

这是整篇里和现状衔接最关键、也最容易把 vCenter 搞挂的一步，单独成节慢慢讲。

**现状**：在 vCenter 篇里，我们是在 OPNsense 的 Unbound 上，给 `yx-vc01` 和三台 ESXi 主机配的正/反向解析（`corp.yanxing.internal` 这个后缀下的名字，当时由 Unbound 以 host override / 本地区域的形式临时充当权威）。现在 `corp.yanxing.internal` 成了一个真正的 AD 域，AD 集成 DNS 才是这个区域天然的权威持有者。所以要做一次「权威交接」。

**我们采用的做法（方案 a）**：让域控对 `corp.yanxing.internal` 做权威解析，对这个域之外的一切（公网、其他内网名字）由 DC 上配的转发器（forwarder）转给 OPNsense 在 SERVER 网段的接口 `10.0.40.1` 去解（不走管理网的 `10.0.10.1`，原因见下面步骤 3）；同时把原来在 Unbound 里的 `yx-vc01`、三台 ESXi 的 A/PTR 记录，在 AD DNS 里重新建出来，并把这些基础设施节点的 DNS 指向改到域控。交接完成后，内网名字由 AD DNS 统一解析，外网名字经 DC 转发器走 OPNsense 出去。

具体步骤：

1. **在 AD DNS 建反向查找区域**。正向区域 `corp.yanxing.internal` 提升时已自动建好；反向区域要手动加。至少建两个：管理网段的 `10.0.10.0/24`（区域名 `10.0.10.in-addr.arpa`）和业务网段的 `10.0.40.0/24`（区域名 `40.0.10.in-addr.arpa`）。都建成 AD 集成区域，这样第二台 DC 起来后会自动复制一份。

![](https://img.gulugulublog.com/posts/enterprise-vsphere-lab-07-ad-dns/20260626004130255.png)

2. **重建基础设施记录**。在正向区域 `corp.yanxing.internal` 里，手动补上 `yx-vc01 → 10.0.10.20`、`yx-esxi01 → 10.0.10.11`、`yx-esxi02 → 10.0.10.12`、`yx-esxi03 → 10.0.10.13` 的 A 记录（建 A 记录时勾上「同时创建关联的 PTR 记录」，反向就一并有了）。`yx-dc01` 自己的 A/PTR 在提升时已经有了。

![](https://img.gulugulublog.com/posts/enterprise-vsphere-lab-07-ad-dns/20260626004326810.png)

3. **在 DC 上配转发器**。DNS Manager → 服务器节点右键 Properties → Forwarders，加上 `10.0.40.1`（OPNsense 在 SERVER 网段 VLAN40 上的接口地址）。这样 DC 解不出来的公网域名会转给 OPNsense，再由它递归或继续转发出去。**注意这里别图省事写 `10.0.10.1`**：网络篇已经做了管理网隔离，下游的 SERVER / CLIENT 网段主动访问 MGMT_NET 会被 block；DC 在 SERVER 网段，去找管理网的 `10.0.10.1:53` 很可能被你自己的规则拦下。用同网段的 `10.0.40.1` 既不绕路也不撞规则。前提是 OPNsense 的 Unbound 在 SERVER 接口上监听并允许该网段查询（默认监听 All 或已放行 SERVER 即可）。真要坚持用 `10.0.10.1`，就得在 SERVER 接口那条 block 规则上方补一条 `SERVER_NET → FW_MGMT_IP UDP/TCP 53 pass` 例外——不如直接用 `10.0.40.1` 干净。

![](https://img.gulugulublog.com/posts/enterprise-vsphere-lab-07-ad-dns/20260626004614317.png)

4. **改各节点的 DNS 指向**：

   - `yx-dc01` 自己的首选 DNS 从 `127.0.0.1` 改成指向另一台 DC、回环作备（等 dc02 起来后定为：首选 `10.0.40.11`、备用 `127.0.0.1`，这是双 DC 的推荐交叉指法，避免单台 DC 重启时自我解析卡住）。在 dc02 还没起来之前，dc01 可暂时维持 `127.0.0.1`。
   - `yx-vc01`、`yx-esxi01/02/03` 的 DNS 从原来的 `10.0.10.1`（OPNsense）改成指向域控。**此刻 dc02 还没建，先只指 `10.0.40.10` 这一台**；等下一节 dc02 提升完、AD DNS 区域复制好、`10.0.40.11` 的 53/636 都确认可用之后，再把 `10.0.40.11` 加为各节点的备用 DNS。别在这一步就把备用 DNS 指向一个还不存在的地址。

{% note danger %}
**vCenter 对 DNS 极其敏感，动它的解析之前先打快照。** vCenter 启动和很多内部服务都依赖 DNS 正反向解析一致，解析一旦不对，轻则 vSphere Client 服务起不来，重则一堆服务报错。动 `yx-vc01` 的 DNS 指向之前，先给 VCSA 关机打一个冷快照（若是 ELM 链接模式要给所有 VCSA 一起打）。改完之后，务必在 vc01 上正反双向都验证一遍：`nslookup yx-vc01.corp.yanxing.internal` 要解出 `10.0.10.20`，`nslookup 10.0.10.20` 要反解回 `yx-vc01.corp.yanxing.internal`；三台 ESXi 同理。正反向哪个对不上都先别往下走。
{% endnote %}

{% note warning %}
**改 VCSA 自己的 DNS，入口和坑都和普通机器不同。** 改的地方在 VAMI（`https://10.0.10.20:5480` → Networking → nic0 → Edit），不是 vSphere Client；用 root 登。几个要点与可能踩到的报错：
- **先决条件别漏**：切到 DC 之前，AD DNS 里必须已有 `yx-vc01` 的正/反向记录、且 VCSA 能到 DC 的 53（跨网段，OPNsense 要放行 MGMT→SERVER），否则 VCSA 切过去后解析不了自己会出问题。
- **多个 DNS 用逗号分隔**（`10.0.40.10,10.0.40.11`）
- 完成后手动重启服务。
- 验证别只信 `nslookup`：VCSA 的 `nslookup` 可能经本机 `127.0.0.1` 的本地解析器答出来，「能解析」不等于「能直连 DC」，跨段连通要用 `curl -v telnet://10.0.40.10:53`（或 636）实测。
{% endnote %}

{% note primary %}
**生产环境对照，以及方案 b 的取舍。** 我们选的方案 a，本质就是生产的标准形态：内网由 AD 集成 DNS 做权威解析器，所有基础设施和域成员都把 DNS 指向域控，域控再把外网请求转发出去——AD DNS 是内网的「中心」，边界设备（这里的 OPNsense）退化成纯上游转发。

另一条路是方案 b：保持 OPNsense Unbound 当主解析器不动，只在 Unbound 上对 `corp.yanxing.internal` 这个域做条件转发（conditional forward）指向 DC，让 DC 只管自己这一个 AD 区域。方案 b 的好处是完全不用碰 `yx-vc01` 和三台 ESXi 的现有 DNS 指向，对已经跑着的 vCenter 风险最低；代价是内网解析变成「OPNsense 主、AD 区域转发」的split-brain 式结构，不如方案 a 干净，也偏离生产形态。
{% endnote %}

## 4 部署第二台域控 yx-dc02

一台域控是单点：它一挂，全公司认证和这套 AD DNS 全停。所以正经做法是至少两台域控，互为冗余——AD 数据库多主复制、DNS 区域各存一份、谁在线都能认证。

建 `yx-dc02` 的 VM 规格和 dc01 一样（2 vCPU / 4 GB / 60 GB / UEFI / `YX-Server` VLAN40）。装好系统、改名 `yx-dc02`、配静态网络：IP `10.0.40.11/24`、网关 `.1`，**首选 DNS 这次要指向已经在跑的 dc01（`10.0.40.10`）**——因为它要先能找到现有域才能加进去。

**提升之前，同样先确认 dc02 的时间是对的**——和 dc01 一个道理：dc02 提升后也会自动注册一张用于 LDAPS 的域控证书，时钟不对又会埋 `NotBefore` 的雷。但 dc02 是额外域控、不是 PDC，**别给它配 `manualpeerlist` 去指外部源**；它提升入域后会自动跟域层级（即跟 dc01 这个 PDC）同步。所以这里只需保证它当前系统时间大致正确即可：若嵌套 VM 关机后时钟跑飞，先手动把时间设到与 dc01 一致，再提升。提升完成后用 `w32tm /query /status` 确认它的 `Source` 指向了域内的 dc01（而非 `Local CMOS Clock`）。

装 AD DS 角色后进提升向导，这次在 Deployment Configuration 选 **Add a domain controller to an existing domain（向现有域添加域控）**，域填 `corp.yanxing.internal`，凭据用域管理员、**填 UPN 格式 `administrator@corp.yanxing.internal`**；Domain Controller Options 里保持勾选 DNS server（让它也成为 DNS 副本），设 DSRM 密码。装完重启。

![](https://img.gulugulublog.com/posts/enterprise-vsphere-lab-07-ad-dns/20260626014200230.png)

重启后回到 dc01 / dc02 任一台，把双 DC 的 DNS 指向定为交叉互指 + 回环备用：dc01 首选 `10.0.40.11`、备用 `127.0.0.1`；dc02 首选 `10.0.40.10`、备用 `127.0.0.1`。AD 集成 DNS 区域会自动复制到 dc02，前面建的反向区域和手建的基础设施记录都会出现在 dc02 的 DNS Manager 里——这就是把 DNS 也做成了冗余。

![](https://img.gulugulublog.com/posts/enterprise-vsphere-lab-07-ad-dns/20260626021754642.png)

dc02 起来后，还要补两件事，否则后面 vCenter 接入时可能踩坑：

- **确认 dc02 的 LDAPS 也通**。dc01 装了企业根 CA 后域控会各自自动注册域控证书，但 dc02 若是在 CA 配好之前提升、或先注册了一张时间不对的证书，它的 636 可能虽在监听却没有可用证书——表现为连接建立后立刻 `Connection reset by peer`（TLS 握手被对端重置；这不是防火墙，防火墙是超时/拒绝）。在 dc02 上 `certutil -pulse`（必要时 `gpupdate /force` 后重启一次）触发重新注册，再用 `ldp.exe` 连 `yx-dc02.corp.yanxing.internal:636`（勾 SSL）验证能 bind。**两台 DC 的 636 都必须可用**——5.2 填了主备两个 URL，vCenter 探测时两台都会碰，dc02 没就绪会让整个身份源探测失败。
- **现在才把 `10.0.40.11` 加为各节点备用 DNS**。确认 dc02 的 53/636 都可用后，回到 `yx-vc01` 和三台 ESXi，把备用 DNS 补成 `10.0.40.11`（首选仍 `10.0.40.10`）。至此基础设施节点才真正有了冗余的 DNS 解析。

{% note primary %}
**生产环境对照。** 我们这两台 DC 跑在同一套嵌套集群、甚至可能落在同一台物理宿主上：这给到的是「逻辑冗余」（AD 复制、DNS 副本、一台 DC 软件层故障时另一台顶上），但不是「物理容错」——宿主一断电两台一起没。生产会把多台 DC 分散到不同宿主、不同机架乃至不同站点，并用 DRS 反亲和规则（anti-affinity）强制它们不落在同一台主机上。等系列收尾讲完整架构差距时，这条会再出现在总清单里。
{% endnote %}

## 5 把 vCenter 接入 AD（Active Directory over LDAPS）

域和 DNS 都稳了，现在把 vCenter 接进来。这里全程在 vSphere Client 里用 `administrator@vsphere.local` 操作。

### 5.1 准备一个查询账号和一个管理员组

在 dc01 的 **Active Directory Users and Computers** 里先建好这几样：

- **一个查询账号** `svc-vcenter-ldap`：长口令、口令永不过期、只需读取/浏览目录的权限（普通域用户默认就够）。vCenter 用它去 AD 查用户和组。**切勿拿域管理员当查询账号**——它的口令要存进 vCenter 配置，权限越小越好。
- **一个管理员组** `grp-vsphere-admins`：建成 **Global / Security** 组（单域环境 Global 足够；必须是 Security 组才能用于授权，Distribution 组不行）。
- **一个你自己的个人域账号**，加进 `grp-vsphere-admins`，日常用它登 vCenter。**别拿内置 `administrator` 当日常账号**——它权限过大、日志也分不清是谁干的。这个个人账号不需要塞进 Domain Admins，它的 vSphere 权限来自下面 5.3 对组的授权。**权限授组不授人**：以后人员变动只在 AD 调组成员，vCenter 侧的授权一个字都不用改。

![](https://img.gulugulublog.com/posts/enterprise-vsphere-lab-07-ad-dns/20260626022813682.png)

{% note primary %}
**生产环境对照。** 生产不会只有一个超管组，而是按职责分层建组、对应 vCenter 不同角色，例如 `grp-vsphere-admins`→Administrator、`grp-vsphere-readonly`→Read-only（审计/查看）、`grp-vsphere-operators`→只能开关机/快照的自定义角色。另外，接入 AD 后也别把 SSO 本地超管 `administrator@vsphere.local` 丢一边——它是 break-glass（救急）账号：万一 AD 故障或 LDAPS 证书出问题导致域账号全登不进，还得靠它进 vCenter。日常用域账号，这个本地超管口令收好备用、别停用。
{% endnote %}

### 5.2 添加 AD over LDAP 身份源

路径：**Administration → Single Sign On → Configuration → Identity Provider** 标签页 → **Identity Sources** → **ADD**，类型选 **Active Directory over LDAP server**。各字段按下表填（UI 字段名保持英文原样）：

- **Identity source name**：`corp.yanxing.internal`（起个能认出来的名，一般就用域名）
- **Base distinguished name for users**：`DC=corp,DC=yanxing,DC=internal`
- **Base distinguished name for groups**：`DC=corp,DC=yanxing,DC=internal`
- **Domain name**：`corp.yanxing.internal`
- **Domain alias**：`YANXING`（NetBIOS 名）
- **Username**：查询账号，填 `svc-vcenter-ldap@corp.yanxing.internal`
- **Password**：该账号口令
- **Connect to**：实验里**建议手填主/备两个 URL**更可控：`ldaps://yx-dc01.corp.yanxing.internal:636` 和 `ldaps://yx-dc02.corp.yanxing.internal:636`。也可以选 **Connect to any domain controller in the domain**（靠 DNS SRV 找 DC），但用它之前要先确认 DNS SRV 记录和两台 DC 的 636 都没问题，否则 vCenter 可能随机命中尚不可用的那台。
- **Certificates (for LDAPS)**：Browse 选入前面 AD CS 根 CA 的证书（启用 LDAPS 时必填）

![](https://img.gulugulublog.com/posts/enterprise-vsphere-lab-07-ad-dns/20260626024003421.png)

填完 Add。回到 Identity Sources 列表能看到 `corp.yanxing.internal` 出现，就说明身份源加成了。

![](https://img.gulugulublog.com/posts/enterprise-vsphere-lab-07-ad-dns/20260626033334364.png)

{% note warning %}
**几个接入时高频会踩的坑，提前说在这。**

- **Username 报「Invalid DN syntax.」**：把用户名从 `svc-vcenter-ldap@corp.yanxing.internal` 改成完整 DN 格式再试，例如 `CN=svc-vcenter-ldap,CN=Users,DC=corp,DC=yanxing,DC=internal`。
- **LDAPS 证书将来轮换时，不能原地改，要删了重建身份源**。vCenter 的 SSO 把 LDAPS 证书的信任状态缓存在身份源条目里，证书一换，原地 Edit 经常报「Can't contact LDAP server」这种误导性错误（其实网络和 636 都通）。正解是把这个身份源 Remove 再重新 Add（删之前先把所有字段截图记下来）。这条在生产里每隔证书有效期就要遇到一次，先知道在这。
- **「Protected Users」组里的账号无法通过 AD over LDAP 登录**：这是该接入方式的固有限制。别把要登 vCenter 的管理员账号放进 Protected Users 组。
{% endnote %}

{% note warning %}
**身份源添加失败时按报错对症，这里只列最可能的原因。**
- **`Certificate is not valid: NotBefore: <未来时间>`**：根 CA 在 dc01 时间没同步时签发，证书生效时间落在未来。根因是签发早于 NTP 同步，不是证书格式、也不是 vCenter——**重配 CA / 重签证书**即可，别去调 VCSA 时间迁就坏证书。
- **`Failed to probe provider connectivity … Can't contact LDAP server`**：两种常见原因。一是 VCSA（管理网）到 DC（SERVER 网）的 **636 跨网段没放行**；二是**主备某台 DC 没有可用 LDAPS 证书**（连上后立刻 reset，见 §4），回去对那台 `certutil -pulse`。端口通不通用 `curl -v telnet://10.0.40.10:636` 实测（出现 `Established` 即通），别拿 `nslookup` 代替。
{% endnote %}

### 5.3 把管理员组授予 vCenter 权限

身份源只是让 vCenter「认识」AD 里的人和组，但「认识」不等于「有权限」——权限是在 Global Permissions 里把某个**角色（Role）**绑到某个**组**上的那一刻才产生的；组名叫什么不影响权限，授了哪个角色才算数。到 **Administration → Access Control → Global Permissions** → ADD，Domain 选 `corp.yanxing.internal`，User/Group 里找到刚建的 `grp-vsphere-admins`，Role 给 **Administrator**，勾上 **Propagate to children**。

![](https://img.gulugulublog.com/posts/enterprise-vsphere-lab-07-ad-dns/20260626034018186.png)


然后退出登录，用你那个个人域账号验证：登录页输入 UPN 格式 `你的用户名@corp.yanxing.internal`和域口令，能进 vSphere Client 且是管理员视图，这条就通了。

![](https://img.gulugulublog.com/posts/enterprise-vsphere-lab-07-ad-dns/20260626180630402.png)

{% note primary %}
**生产环境对照，以及 vSphere 9 的走向。** 我们这里用的 AD over LDAPS，是 8.0U3 当下的推荐法，但它仍是「目录查询 + 口令在 vCenter 校验」的模式。更现代的做法是 **Identity Provider Federation（身份联合）**：vCenter 把认证彻底托付给一个外部 IdP（AD FS、Microsoft Entra ID、Okta 等），vCenter 自己从不经手用户口令，还能顺带拿到 MFA、条件访问这些能力。

到 vSphere 9.0，IWA（域加入法）被彻底移除：从 8.0U3 升级到 9.0 之前，必须先退出 AD 域，否则升级预检会直接报错拦住你；好在迁移时只要保持 Domain Name 和 Alias 不变，vCenter 对象上已有的权限会保留。`Use Windows session credentials`（SSPI，用当前 Windows 会话免密登录）这个能力也在 9.0 被移除。ESXi 主机的 AD 认证在 9.0 仍然支持。一句话：生产现在就该把身份统一到 AD over LDAPS 或联合身份上，别再依赖 IWA。
{% endnote %}

## 6 管理跳板机 yx-jump01

序章规划里还有一台 `yx-jump01`（管理跳板机，`10.0.40.30`），到这里正好顺势把它立起来——因为它和 AD、DNS、权限审计是一套逻辑。

**先说它是什么、为什么这篇补。** 跳板机（jump host，也叫堡垒机 bastion）是一台专门用于进入内网管理面的中转主机：运维人员不再从外部或宿主机直接访问内部资产，而是先登录到这台受控主机，再从它出发去管理 vCenter、ESXi、域控、TrueNAS 等组件。把它放在身份篇补，是因为它应该长在内网里、加入 `corp.yanxing.internal` 域、用域账号登录，并通过 AD DNS 解析内部主机名——这样从它出发，名称解析、账号审计、访问路径都能纳入同一套体系。

这也正好对照出我们前面一直在用的"土办法"：直接拿宿主机，也就是那台 Windows 笔记本裸连内部环境。宿主机游离在 AD 体系之外，所以一路上会遇到"解析不出 `yx-vc01`、访问 `\\10.0.40.10\c$` 要在宿主加路由、打开 VAMI 只能用 IP"这些别扭。换成一台加了域的跳板机，这些绕路就少很多：它在内部 DNS 体系里，能用域账号登录，也能作为统一的运维入口。

**但有一个跨网段的前提必须先开。** `yx-jump01` 放在 `YX-Server`（VLAN40 / `10.0.40.0/24`）里，而网络篇已经做了管理网隔离，默认阻断 `SERVER_NET → MGMT_NET`。所以跳板机要管理 vCenter / ESXi，必须在 OPNsense 上单独给它开一条精确例外——这又是本系列反复出现的那类"反方向口子"（和 DNS 的 53、LDAPS 的 636、NTP 的 123 一样，都是下游网段主动访问管理网、方向与隔离规则相反，最容易漏）：

| Interface | Action | Source | Destination | Port | 说明 |
|---|---|---|---|---|---|
| SERVER | pass | `10.0.40.30` / `JUMP_HOST` | `MGMT_NET` | 443、按需 5480 / 902 / 22 | 只放跳板机进管理网 |
| SERVER | block | `SERVER_NET` | `MGMT_NET` | any | 阻断其它服务器主动进管理网 |

这条 `JUMP_HOST → MGMT_NET` 的 pass 规则必须放在原来的 `SERVER_NET → MGMT_NET` block 规则**上方**，否则会被 block 先命中而失效。端口按需最小放行（443 走 vSphere Client / VAMI / ESXi、5480 走 VAMI、902 走 ESXi 控制台、22 走 SSH），别图省事开 `any`——这样就形成"普通业务网主机进不了管理网，只有跳板机能作为受控入口"的姿态。

{% note primary %}
**生产环境对照。** 真实企业里，管理入口通常不会是"某台什么都干的机器裸连"，而是一套专职堡垒机 / PAM / 管理入口体系：只开放极少入口，配合 MFA、会话审计、命令记录、最小权限和访问审批；内部资产只接受来自指定跳板机或管理网段的连接，其它来源一律拒绝。这个角色在等保、ISO 27001、PCI-DSS 等合规场景里通常也是重点检查对象；云上也有类似形态，例如 AWS Session Manager / bastion、Azure Bastion，以及 CyberArk、JumpServer 等专门产品。我们这套实验室全程用宿主机凑合，是为了省内存和简化流程；生产里这类管理入口是收敛、加固、审计管理访问的关键一环，不应省略。
{% endnote %}

**一个轻量部署示例。** 在本实验内存吃紧的前提下，跳板机给最小配置即可；甚至可以平时关机，要集中运维时再开：

- 建一台小 VM `yx-jump01`：2 vCPU、4 GB 内存、UEFI、网络挂到 `YX-Server`（VLAN40）端口组；操作系统可用 Windows Server 评估版，复用前面的 ISO。这里以 Windows 为例，方便安装图形化管理工具。
- 静态网络：IP `10.0.40.30/24`，网关 `10.0.40.1`，DNS 指向两台域控 `10.0.40.10` / `10.0.40.11`。
- 加入 `corp.yanxing.internal` 域：系统属性里改域，用域管理员凭据；凭据建议用 UPN 格式，例如 `administrator@corp.yanxing.internal`，避开 down-level 格式在未加域机器上偶发的定位问题。
- 安装日常运维工具：RSAT（Active Directory Users and Computers、DNS Manager 等）、浏览器、SSH 客户端，按需再装 PowerCLI。开好上面那条例外规则后，日常管理尽量从这台跳板机进入：浏览器里访问 `https://yx-vc01.corp.yanxing.internal/ui`、`https://yx-vc01.corp.yanxing.internal:5480`，或访问三台 ESXi 的 FQDN，而不是继续从宿主机到处用 IP 和静态路由绕进去。

{% note warning %}
**内存又紧一格，按需开关。** 这台虽然只有 4 GB，但宿主已经贴边，常驻会再吃一份资源。建议把它当作"按需运维入口"：集中管理时开机，平时可关掉腾内存；或者只把它作为概念演示部署一遍，日常仍临时用宿主机顶替。这和前面"按需关 `yx-test01` / 压 esxi02、esxi03 内存"的思路一致。
{% endnote %}

## 7 验证与检查点

把这一篇该绿的都绿一遍再收工：

- **域账号登录**：用 `grp-vsphere-admins` 里的域账号能登进 vCenter 且为管理员——这是本篇的主目标。
- **DNS 正反向**：在 `yx-vc01` 和三台 ESXi 上分别 `nslookup` 自己的 FQDN 和 IP，正向、反向都对得上；外网名字（如某公网域名）也能经 DC 转发器解析出去。
- **两台 DC 复制健康**：在任一 DC 上跑 `repadmin /replsummary`（汇总无报错、无大 delta）、`repadmin /showrepl`（各方向 last success 时间新鲜），再跑一遍 `dcdiag /v` 看各项检查通过。两台 DC 的 DNS Manager 里 `corp.yanxing.internal` 区域内容一致，说明 AD 集成 DNS 复制正常。
- **集群面板照旧**：vSAN / HA / DRS 仍然全绿，Skyline 没有新增红项（嵌套环境固有的 HCL / 监控类预期告警沿用前几篇的判断口径，核心数据面绿即可）。

{% note success %}
**到这里，砚行物流的平台第一次有了「公司身份」。** 计算、网络、存储、高可用之上，现在叠了统一的目录与认证，`YX-Server`(VLAN40) 也住进了它的头两台正式服务器。从此加人减权都在 AD 里完成，vCenter 只认组、不管人。
{% endnote %}

## 结语：下一篇把时间对齐

身份立住了，还剩最后一块地基没夯实——时间。AD 域里，PDC 模拟器是整个域的时间权威，域成员都跟着它走；而 vSAN、HA 这些恰恰对时间同步很敏感（Skyline 里就有「主机与 VC 时间是否同步」这一项），时间一漂就会出问题。下一篇（也是本系列最后一篇）会把整套时间层级理顺到域控上，顺手收回当初在网络篇为 OPNsense 开的那条 NTP 放行规则，再补讲一直推迟到收尾才讲的 vLCM 镜像，最后对砚行物流这套从物理规划一路走到身份与时间的平台，做一次整体回顾和「实验 vs 生产」的总差距清单。

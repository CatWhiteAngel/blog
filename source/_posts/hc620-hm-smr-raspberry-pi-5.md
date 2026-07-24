---
title: Ultrastar DC HC620 分析与实战——树莓派 5 驱动主机管理式 SMR 硬盘
date: 2026-07-16 16:01:00
update: 2026-07-24 14:35:00
categories: [Hardware]
tags: [Raspberry Pi, SMR, Storage, Linux]
description: 西数 Ultrastar DC HC620 是主机管理式 SMR（HM-SMR）硬盘，在 Windows 或未启用 zoned 块设备支持的 Linux 内核中无法正常作为块设备使用，二手价因此便宜到离谱。本文分析 HM-SMR 的原理与限制，并用树莓派 5 加 PCIe 转 SATA 扩展板把它完整跑起来：系统选择、内核支持验证、zone 勘察，以及 dm-zoned、btrfs zoned、f2fs 三种文件系统方案的实测对比。
---

# Ultrastar DC HC620 分析与实战——树莓派 5 驱动主机管理式 SMR 硬盘

在二手平台搜索大容量机械盘时，很容易见到这样一类商品：西数（HGST）Ultrastar DC HC620，14TB，氦气企业盘，价格明显低于同容量的普通企业盘，商品描述里通常只带一句含糊的"需专用系统"或"不支持普通电脑"。价格低并非盘本身有故障，而是因为它属于**主机管理式叠瓦盘（Host-Managed SMR，HM-SMR）**。这类盘接入 Windows 无法识别，接入未启用 zoned 块设备支持的 Linux 内核时，`lsblk` 中也不会出现盘符，树莓派官方系统的内核恰好属于后者。多数买家因此无法正常使用，二手价格随之维持在低位。

但"系统不直接支持"与"不能用"是两回事。Linux 自 4.10 起引入分区块设备（Zoned Block Device）的核心支持，dm-zoned、zonefs、btrfs zoned 等组件在后续版本中陆续完善。本文的验证平台由一块 14TB 的 HC620、一台树莓派 5 和一块 PCIe 转 SATA 扩展板组成。

这套方案适合**冷备份、顺序归档、一次写入多次读取**的场景，顺序读写可以接近盘体的标称上限（233 MB/s）。它**不适合**用作普通 NAS 数据盘、下载盘或任何随机写密集的用途，即便通过 dm-zoned 这类兼容层屏蔽 zone 约束，效果也只是"能用"而非"好用"。如果需求是一块即插即用的仓库盘，更合理的做法是增加预算购买 CMR 盘。

## 1 SMR 四象限：先分清买的是哪一种

机械盘按记录方式和管理方式可以分成四类，购买二手大容量盘之前需要先分清：

**CMR（Conventional Magnetic Recording，传统垂直记录）**。磁道互不重叠，任意扇区可随机改写，即通常所说的普通硬盘。

**DM-SMR（Drive-Managed SMR，盘管理式叠瓦）**。磁道部分重叠以换取存储密度（shingled 即瓦片式堆叠之意），改写一条磁道必须重写一整片。盘内固件在内部处理这些重写，对系统表现为普通硬盘，代价是缓存写满后性能大幅下降。消费级低价大容量盘的性能问题多出在这一类，且系统层面无法直接识别，只能查询型号确认。

**HA-SMR（Host-Aware SMR，主机感知式）**。介于两者之间，既接受随机写也暴露 zone 接口，市面上很少见。

**HM-SMR（Host-Managed SMR，主机管理式）**。不向主机隐藏叠瓦结构，而是将其以"区（zone）"的形式直接暴露给主机，通过 ZBC（SCSI）/ ZAC（ATA）命令集管理，**只接受符合规则的顺序写入**，违规写入直接返回 I/O 错误。数据中心用它换取可预测的性能和最高的存储密度。HC620 属于这一类，也是唯一一类接入后系统不显示盘符的。

识别方法按可靠程度排序：最可靠的是查型号，HC620 的 SATA 型号为 `HSH721414ALE6M0`（14TB、512e）、`HSH721414ALN6M0`（14TB、4Kn）及对应的 15TB 型号 `HSH721415ALE6M0` / `HSH721415ALN6M0`，型号以 `HSH` 开头基本都属于这个家族。其次看商品页关键词，"host managed"、"主机管理"、"需专用系统/服务器"、"不支持个人电脑"都是信号。最后，盘到手后在支持 zoned 的系统上执行一条命令即可定性：

```bash
cat /sys/block/sda/queue/zoned
# host-managed → HM-SMR
# host-aware   → HA-SMR
# none         → CMR 或 DM-SMR（DM-SMR 对系统不可见，只能查型号）
```

{% note warning %}
购买前确认接口是 **SATA**。HC620 有 SATA 和 SAS 两种接口，SAS 版往往更便宜，但本文使用的 PCIe 转 SATA 方案无法连接 SAS 盘，需要额外的 SAS HBA 卡，功耗和体积都是另一个量级，不在本文范围内。
{% endnote %}

## 2 HC620 是一块什么盘

基本规格：3.5 寸、7200 RPM、氦气封装（HelioSeal 第四代）、512MB 缓存、官方标称最高持续传输率 233 MB/s（223 MiB/s，外圈值，向内圈递减，实测见后文）、额定年写入负载 550TB、MTBF 250 万小时。2018 年发布时，15TB 型号是全球第一块 15TB 企业盘。

真正决定使用方式的是它的 zone 布局。整块盘的地址空间划分为若干 **256 MiB 的区**，分为两种类型：

- **常规区（Conventional Zone）**：位于盘的起始位置，容量占比很小（15TB 型号实测为 130GiB 出头），支持随机读写，行为与普通硬盘一致。后文会提到，dm-zoned 和 f2fs 的元数据都存放在这部分常规区。
- **顺序写区（Sequential Write Required Zone）**：占据其余全部空间。每个区维护一个**写指针（Write Pointer）**，写入必须精确落在写指针位置并顺序推进。改写已有数据时，只能将整个区**重置（Reset）**后从头写入。随机读不受限制。

具体到容量：14TB 512e 型号共 52156 个区（每区 524288 个 512B 逻辑块），15TB 4Kn 型号共 55880 个区（每区 65536 个 4K 逻辑块），均为 256 MiB。后文执行 `blkzone report` 时可以核对这个数字。

512e（`ALE`）和 4Kn（`ALN`）型号在本文方案下均可使用，物理扇区都是 4K，区别仅在于逻辑扇区大小。二手市场上 512e 更常见，本文以 14TB 512e 为例。

到手后的检测流程与普通企业盘相同，`smartctl` 可正常工作，重点关注通电时间、`Reallocated_Sector_Ct` 和 UDMA CRC 错误。注意 Ubuntu Server 没有预装 smartmontools：

```bash
sudo apt install smartmontools
sudo smartctl -a /dev/sda
```

本盘实测关键字段：整体评估 PASSED，**通电 55441 小时（约 6.3 年）**，`Reallocated_Sector_Ct`、`Current_Pending_Sector`、`Offline_Uncorrectable`、`UDMA_CRC_Error_Count` 全部为 0，`Helium_Level` 为 100，盘温 36°C。

数据中心退役盘的通电时间普遍在数万小时，判断健康状态应依据缺陷计数和氦气水平，而不是使用时长。这块盘运行六年多，各项指标仍然全部正常。smartctl 会提示 `Device is: Not in smartctl database`，HC620 不在其识别库中，这属于正常现象，不影响属性读取。

## 3 硬件准备

**必需：**

- 树莓派 5，内存大小不影响本方案，2GB 版本即可满足需求，本文实测使用的是 8GB 版本
- PCIe 转 SATA 扩展板。本文选用微雪 **PCIe TO 2-CH SATA HAT+**，价格约 100 元，包装内含 16PIN FPC 排线、SATA 数据电源一体线和铜柱。实测主控为 ASMedia **ASM1061/1062**，PCI ID 为 `1b21:0612`，提供双 SATA 接口，链路规格为 PCIe 2.0 x1。选型时具体芯片型号不是首要因素，关键是**必须支持 AHCI 协议**，因为 ZAC 命令需要经内核 libata 层原生传递。ASM1061、JMB582、JMB585、ASM1166 这类标准 AHCI 控制器都满足这一要求。多数 USB 转 SATA 桥接方案无法透传 zone 管理命令，除非产品明确声明支持相关 ZAC/ZBC 命令透传，因此不建议使用 USB-SATA 硬盘盒。ASM1061 与 HM-SMR 组合可能存在 NCQ 兼容性问题，可通过修改内核参数解决，详见第 5 节。预算允许的情况下，选用 JMB585 或 ASM1166 等更新的主控方案会更稳妥。
- 12V 电源。这块扩展板提供 12V DC 输入接口，规格为 **4.0mm × 1.7mm**，并板载 5V 和 12V 硬盘供电，这是选用它的另一个原因，3.5 寸硬盘所需的 12V 供电树莓派自身无法提供。硬盘启动瞬间 12V 电流普遍在 2A 上下，单盘建议按不低于 3A 留余量，双盘则需相应翻倍。
- HC620 本体（SATA 版）

**可选：**硬盘支架或减震垫（7200 转企业级硬盘的震动和噪音比桌面盘更明显），以及给 SATA 主控芯片贴的小散热片。

```bash
lspci -nn
```

```
0001:00:00.0 PCI bridge [0604]: Broadcom Inc. and subsidiaries BCM2712 PCIe Bridge [14e4:2712] (rev 21)
0001:01:00.0 SATA controller [0106]: ASMedia Technology Inc. ASM1061/ASM1062 Serial ATA Controller [1b21:0612] (rev 02)
0002:00:00.0 PCI bridge [0604]: Broadcom Inc. and subsidiaries BCM2712 PCIe Bridge [14e4:2712] (rev 21)
0002:01:00.0 Ethernet controller [0200]: Raspberry Pi Ltd RP1 PCIe 2.0 South Bridge [1de4:0001]
```

SATA 控制器识别为 ASMedia ASM1061/1062，class 0106 即标准 AHCI 控制器，可以正常使用。另外可以看到 Pi 5 的板载千兆网卡走的是另一条 PCIe 链路（RP1 South Bridge），与扩展板互不占用的。

组装过程比较简单。将 FPC 排线连接 Pi 5 的 PCIe 接口和扩展板，注意排线两端锁扣方向，一体线连接硬盘，12V 电源接扩展板 DC 口。然后在 `/boot/firmware/config.txt` 中启用外部 PCIe。是否需要手动配置与具体设备有关，较新固件检测到设备后会自动启用。

```ini
dtparam=pciex1
# ASM1061/1062 是 PCIe 2.0 设备，链路只会协商到 Gen2 x1（约 500MB/s）
# 对这块板设置 dtparam=pciex1_gen=3 没有意义，单盘机械硬盘也远用不满 Gen2 带宽
```

## 4 系统选择：为什么原版系统不行

这一节的内容是后续所有工作的前提。HM-SMR 盘要被内核识别为块设备，内核必须启用 `CONFIG_BLK_DEV_ZONED`（分区块设备支持，Zoned Block Device）。该选项启用后，SCSI 子系统对 ZBC/ZAC 盘的支持和 f2fs 的 zoned 支持会一并开启，dm-zoned 和 zonefs 则还需要各自的选项。

问题在于，Raspberry Pi OS 的官方内核没有启用这些选项。本文核对过 rpi-6.12.y 和 rpi-6.18.y 两个分支，在 arch/arm64/configs/bcm2712_defconfig 中，CONFIG_BLK_DEV_ZONED、CONFIG_DM_ZONED 和 CONFIG_ZONEFS_FS 均未启用。后果是 HC620 接上后，内核在 `sd_probe` 阶段直接放弃这块盘，`dmesg` 里只留下一行：

```
sd 0:0:0:0: Unsupported ZBC host-managed device.
```

此时 `lsblk` 看不到这块盘，`/dev/sda` 也不存在。

实测于 Raspberry Pi OS（内核 6.18.34+rpt-rpi-2712）：

```
[    1.578469] scsi 0:0:0:0: Direct-Access-ZBC ATA      HGST HSH721414AL T10B PQ: 0 ANSI: 7
[    1.578658] sd 0:0:0:0: Unsupported ZBC host-managed device.
```

日志显示内核识别出了这是一块 ZBC 设备，随后因不支持而放弃注册，`lsblk` 中只剩 SD 卡。

解决办法有两条：给 Pi OS 自编内核（见附录 A），或者换用默认带 zoned 支持的发行版。我最终选择了 **Ubuntu Server 26.04 LTS（64-bit，树莓派镜像）**。这台机器建成后是 7×24 运行的存储机，自编内核意味着每次 `apt` 更新内核都要重编一遍，或者永久 hold 内核包并放弃安全更新。Ubuntu 的 `linux-raspi` 内核由 apt 正常维护，zoned 支持不会因更新而丢失。26.04 基于内核 7.0，zoned 相关的代码也足够新。

烧写时在 Raspberry Pi Imager 中选择 Other general-purpose OS → Ubuntu → **Ubuntu Server 26.04 LTS (64-bit)**，用户名和 SSH 都可以在 Imager 的预配置里填好。Wi-Fi 预配置在 Ubuntu Server 上首启不可靠，cloud-init 应用无线配置的时机偏晚，常见表现是首次开机连不上、重启一次后恢复，5GHz SSID 受首启国家码未生效的影响更容易失败。这台机器本身是常开的存储机，首启建议直接插网线，无线可以等系统起来后再用 netplan 配置。另外还有一个 26.04 特有的情况：按官方发布说明，这一版树莓派镜像采用新的启动流程（A/B 启动布局），要求 Pi 5 的 EEPROM 固件日期不早于 2025-02-11，过旧的固件可能无法启动该镜像。如果 Pi 5 库存时间较久，先在任意能启动的系统里执行：

```bash
sudo rpi-eeprom-update      # 查看当前固件日期
sudo rpi-eeprom-update -a   # 过旧则升级，然后重启
```

实测本机固件日期为 2025-05-08，满足要求，无需操作（Ubuntu 上 `rpi-eeprom-update` 由 `rpi-eeprom` 包提供，可直接使用）。

系统启动后先验证内核配置，这一步的结果决定是否需要参考附录 A 自编内核：

```bash
grep -E "BLK_DEV_ZONED|DM_ZONED|ZONEFS" /boot/config-$(uname -r)
```

```
CONFIG_BLK_DEV_ZONED=y
CONFIG_BLK_DEV_ZONED_LOOP=m
CONFIG_DM_ZONED=m
CONFIG_ZONEFS_FS=m
```

四项全部齐备（实测于 26.04 的 `linux-raspi` 内核 7.0.0-1009-raspi）：块层 zoned 支持直接编进内核，dm-zoned 和 zonefs 以模块形式提供，本文三种文件系统方案都不需要改动内核。作为对照，同一台 Pi 5 换 Raspberry Pi OS 的卡执行同一条命令，结果是 `# CONFIG_BLK_DEV_ZONED is not set`。

再确认两个环境信息，后文实测会引用：

```bash
uname -r            # 实测：7.0.0-1009-raspi
getconf PAGE_SIZE   # 实测：4096
```

## 5 识盘与 zone 勘察

在带有 zoned 支持的内核上接入硬盘并上电。查看内核日志建议使用 `journalctl -k -b` 而不是 `dmesg`。内核环形缓冲区容量有限，一旦出现大量刷屏日志（例如附录 B 中的 AppArmor audit 问题），开机阶段的识盘信息会被挤出缓冲区，此时 `dmesg` 无法查到这些早期记录，而 journal 保存了本次启动的完整内核日志。

```bash
sudo journalctl -k -b | grep -iE "ahci|ata[0-9]|sd[a-z]|zbc"
```

以下为实测输出（节选），其中暴露出一个扩展板兼容性问题：

```
ahci 0001:01:00.0: AHCI vers 0001.0200, 32 command slots, 6 Gbps, SATA mode
ahci 0001:01:00.0: 2/2 ports implemented (port mask 0x3)
ata1: SATA link up 6.0 Gbps (SStatus 133 SControl 300)
ata1.00: ATA-9: HGST HSH721414ALE6M0, L4GMT10B, max UDMA/133
ata1.00: 27344764928 sectors, multi 0: LBA48 NCQ (depth 32), AA
scsi 0:0:0:0: Direct-Access-ZBC ATA      HGST HSH721414AL T10B PQ: 0 ANSI: 7
sd 0:0:0:0: [sda] Host-managed zoned block device
sd 0:0:0:0: [sda] REPORT ZONES start lba 0 failed
sd 0:0:0:0: [sda] Sense Key : Aborted Command [current]
sd 0:0:0:0: [sda] 0 512-byte logical blocks: (0 B/0 B)
（libata 错误处理，链路复位重试约 30 秒）
ata1.00: NCQ disabled due to excessive errors
ata1: SATA link up 6.0 Gbps (SStatus 133 SControl 300)
sd 0:0:0:0: [sda] 27344764928 512-byte logical blocks: (14.0 TB/12.7 TiB)
sda: detected capacity change from 0 to 27344764928
sd 0:0:0:0: [sda] 52156 zones of 524288 logical blocks
```

上述日志的时间线如下。链路正常协商到 6.0 Gbps，内核识别出这是一台 ZBC 设备，但第一条 REPORT ZONES（读取 zone 布局的命令）被盘中止，容量读为 0。libata 反复重试后**自动禁用 NCQ**，此后同样的命令立即成功，容量和区数（52156 个，一致）全部读出，整个收敛过程约一分钟。该序列**每次开机都确定性复现**，逐行节奏一致。这是排除接触不良、供电抖动等物理层原因的依据之一，物理层故障通常表现为随机性，不会每次都精确失败在同一条命令上。

证据强烈指向 **ASM1061 对 NCQ 编码 ZAC 命令的 AUX 字段处理存在缺陷**，理由有三。其一，ZAC 的 zone 管理命令经 NCQ 路径下发时（RECEIVE/SEND FPDMA QUEUED）依赖 FIS 中的 AUX 字段，而内核 `drivers/ata/ahci.c` 对**所有** AHCI 控制器无条件启用该能力，源码注释原文为 "All AHCI controllers should be forward-compatible with the new auxiliary field. This code should be conditionalized if any buggy AHCI controllers are encountered"，即内核开发者已预见到在有缺陷的控制器上会出现此类失败。其二，ASM1061 基于 AHCI 1.2（日志中 `AHCI vers 0001.0200`），是 2011 年的设计，早于 AUX 字段和 ZAC 规范数年，向前兼容的假设在这类老芯片上最难得到保证。其三，内核的盘型号 quirk 表中没有任何 HC620 条目，该盘已在数据中心大规模部署多年，如果其固件的 NCQ ZAC 实现存在缺陷，理应早已被加入黑名单。日志特征也不符合典型的供电或线材故障。综合来看，现有证据高度指向 ASM1061 在 NCQ ZAC 命令处理上的兼容性问题。需要说明的是，本文未进行控制器 A/B 对照或协议级抓包，因此上述结论应视为有充分依据的故障归因，而非已完全证明的芯片缺陷。

此时硬盘已经可以正常使用，但不应每次开机都依赖约一分钟的错误重试完成收敛，需要将关闭 NCQ 的操作固化到内核命令行。在此之前需要先避开一个 26.04 特有的问题：**顶层的 `/boot/firmware/cmdline.txt` 不是启动时实际读取的文件**。26.04 的 A/B 启动布局通过 `config.txt` 中的 `os_prefix=current/` 将固件指向槽位目录，内核、initrd、设备树以及实际生效的 cmdline.txt 都位于 `/boot/firmware/current/` 之下。修改顶层文件不会生效，也不会产生任何报错。判断方法很简单，执行 `cat /proc/cmdline` 查看内核实际收到的参数，如果与所修改文件的内容不一致，就说明改错了文件。正确做法如下：

```bash
grep os_prefix /boot/firmware/config.txt     # 确认当前槽位，通常为 current/
sudo sed -i 's/$/ libata.force=1.00:noncq/' /boot/firmware/current/cmdline.txt
cat /boot/firmware/current/cmdline.txt       # 确认仍为单行且参数在行尾
sudo reboot
```

`1.00` 指 ata1 端口设备 0，即本盘。重启后按顺序验证：

```bash
cat /proc/cmdline                            # 参数应已在其中
cat /sys/block/sda/device/queue_depth        # 应为 1
sudo journalctl -k -b | grep -iE "ncq|report zones"   # 应无 failed
```

实测效果（节选）：

```
kernel: Kernel command line: ... libata.force=1.00:noncq
kernel: ata1.00: FORCE: modified (noncq)
kernel: ata1.00: 27344764928 sectors, multi 0: LBA48 NCQ (not used)
kernel: sd 0:0:0:0: [sda] 52156 zones of 524288 logical blocks
```

`FORCE: modified (noncq)` 表示内核已确认应用该参数。识盘过程从链路协商到读出全部 52156 个区在一秒内完成，全程无失败、无重试。与不添加参数时约一分钟的错误收敛过程相比，可以说明固化该参数的必要性。`queue_depth` 确认为 1。

正常情况下，flash-kernel 会复制 current/cmdline.txt 生成新槽位的 new/cmdline.txt，因此手工添加的 libata.force=1.00:noncq 应当会随内核更新保留。为避免更新流程或人工修改造成意外，每次内核更新后仍建议使用 `cat /proc/cmdline` 复查。

性能方面的代价：NCQ 主要优化并发随机读的排队，对单流顺序读写基本没有影响。这块盘本身也只适合顺序负载，因此该代价可以接受。选购扩展板时如果希望避开这一问题，可以考虑更新的 JMB585/ASM1166 方案，但**任何 AHCI 控制器与 HM-SMR 的组合都建议以实测为准**。

接下来从块层核对几个关键属性：

```bash
lsblk -z                                    # ZONED 列：host-managed，ZONE-NR 52156，ZONE-SZ 256M
cat /sys/block/sda/queue/zoned              # host-managed
cat /sys/block/sda/queue/nr_zones           # 实测：52156
cat /sys/block/sda/queue/chunk_sectors      # 实测：524288，即 256 MiB
cat /sys/block/sda/queue/scheduler          # 实测：none [mq-deadline]，默认即选中
```

`lsblk -z` 中还有两个值得关注的列。ZONE-OMAX 为 128，表示盘允许同时处于打开状态的区数上限，zoned 文件系统的并发写入布局受其约束。ZONE-APP 32M 是内核为 SATA 盘模拟 Zone Append 的单次写入上限，该能力自 6.10 起随 zone write plugging 提供，SATA ZAC 命令集本身并不包含 Zone Append。

调度器方面存在一条新老内核的分界线。Linux 6.9 及更早版本中，zoned 盘的顺序写约束依赖 **mq-deadline** 保证写命令不被重排，属于硬性要求。从 Linux 6.10 起，块层引入了 zone write plugging，写入排序由块层原生处理，不再强制绑定特定调度器。本文使用的 26.04 对应 7.0 内核，mq-deadline **已不是必需项**，实测默认调度器恰好也选中了它。如有需要，可以通过一条 udev 规则固定（可选）：

```bash
cat <<'EOF' | sudo tee /etc/udev/rules.d/99-zoned-scheduler.rules
ACTION=="add|change", KERNEL=="sd[a-z]", ATTR{queue/zoned}=="host-managed", ATTR{queue/scheduler}="mq-deadline"
EOF
```

接下来使用 util-linux 自带的 `blkzone` 查看盘的实际布局，包括盘首部的常规区、其后大量的顺序写区，以及每个区的写指针位置：

```bash
sudo blkzone report /dev/sda | head -20
sudo blkzone report /dev/sda | grep -c CONVENTIONAL   # 常规区总数
```

实测输出（节选）：

```
start: 0x000000000, len 0x080000, cap 0x080000, wptr 0x000000 reset:0 non-seq:0, zcond: 0(nw) [type: 1(CONVENTIONAL)]
...（前 524 个区均为 CONVENTIONAL）
start: 0x010600000, len 0x080000, cap 0x080000, wptr 0x000000 reset:0 non-seq:0, zcond: 1(em) [type: 2(SEQ_WRITE_REQUIRED)]
```

输出读法：`len 0x080000` 为 524288 扇区，即 256 MiB。`wptr` 是**相对区起始的偏移量**，空区为 0。`zcond` 是区状态，常规区标记为 `0(nw)`（无写指针概念），空的顺序写区标记为 `1(em)`（empty）。常规区实测共 **524 个**（约 131 GiB），从盘首连续排布，至扇区 0x010600000 处切换为顺序写区。

此时可以做一个实验，直接验证 HM-SMR 的写入约束。注意不要随意挑选扇区号写入，否则即使报错也无法确定失败原因。严谨的做法是先用 `blkzone report` 找到一个空的顺序写区（`zcond: 1(em)`），其写指针位于区起始处，然后**故意跳过写指针**向区中间写入，使失败原因唯一指向写指针规则。以本盘第一个顺序写区（起始扇区 0x010600000 = 274726912）为例，向区内偏移 1 MiB（2048 扇区）处写入：

```bash
# 危险操作，仅在空盘上实验
sudo blkzone report /dev/sda | grep -m3 SEQ
sudo dd if=/dev/zero of=/dev/sda bs=512 count=8 seek=274728960 oflag=direct
```

```
dd: IO error: Input/output error
```

写入未落在写指针位置，盘按 ZAC 规范拒绝执行。普通文件系统（ext4、xfs、NTFS）的元数据更新全部属于这种原地改写操作，这正是它们无法直接格式化到这块盘上的原因，也是接下来三种方案需要解决的问题。

## 6 方案一：dm-zoned，模拟成普通块设备

dm-zoned 是内核 device mapper 的一个目标（target），基本思路是用盘首的常规区充当随机写缓冲区和元数据区，把整块盘向上模拟成一个**无写入约束的普通块设备**，并在后台执行"缓冲区 → 顺序区"的数据搬运与回收。上层可以直接格式化 ext4 使用。

代价同样来自这一原理：随机写全部先落在盘首 100 多 GiB 的常规区内，写入量增大后会触发回收，性能出现明显波动，模拟层还需要占用一部分容量存放元数据。它是三个方案中**兼容性最好、使用成本最低**的一个，适合只需要一块可正常挂载的大容量盘的场景。

用户态工具 `dmzadm` 来自 dm-zoned-tools 项目，Ubuntu 官方仓库没有收录，需要自行编译（依赖以仓库 README 为准）：

```bash
sudo apt update
sudo apt install build-essential git pkg-config m4 autoconf automake libtool \
  uuid-dev libblkid-dev libudev-dev libdevmapper-dev libkmod-dev
git clone https://github.com/westerndigitalcorporation/dm-zoned-tools
cd dm-zoned-tools
sh autogen.sh && ./configure && make
sudo make install
command -v dmzadm   # 实测安装在 /usr/sbin/dmzadm，systemd unit 里要用这个路径
```

初始化并启动映射：

```bash
sudo modprobe dm-zoned
sudo dmzadm --format /dev/sda --force   # 注意 dmzadm 的选项必须放在设备参数之后，盘上有旧文件系统残留时需 --force
sudo dmzadm --start /dev/sda
ls /dev/mapper/
```

需要 `--force` 的原因如下：`blkzone reset` 只重置顺序写区，**常规区的数据不受影响**，上一文件系统写在常规区中的超级块会一直残留。本文连续测试多个方案，每次格式化时都会检测到前一文件系统的签名，因此强制格式化属于正常操作。这同时也说明 reset 并不能清空整块盘，如需彻底清除数据，必须对常规区单独覆写。

实际执行 format 时，工具先报告 52156 个区的布局，然后重置全部顺序写区，写入**两套互为备份的元数据**（主集位于块 0，副集位于块 131072，各含映射表和位图），随后用 `--start` 建立映射。映射设备名为 `dmz-<盘序列号>`。

之后按常规流程，把 `/dev/mapper/dmz-<盘序列号>` 当作普通盘使用：

```bash
sudo mkfs.ext4 /dev/mapper/dmz-<盘序列号>
sudo mount /dev/mapper/dmz-<盘序列号> /mnt/hc620
```

开机自动挂载需要注意顺序：必须先执行 `dmzadm --start` 创建映射设备，再检查并挂载映射设备上的 ext4 文件系统。不能直接把 `/dev/mapper/dmz-*` 写进 fstab，否则启动早期映射设备尚未出现，挂载会失败。

首先取得原始 HC620 的稳定设备路径：

```bash
ls -l /dev/disk/by-id/ | grep HSH721414ALE6M0
```

假设实际路径为：

```text
/dev/disk/by-id/ata-HGST_HSH721414ALE6M0_<盘序列号>
```

生成对应的 systemd device unit 名：

```bash
systemd-escape --path --suffix=device \
  /dev/disk/by-id/ata-HGST_HSH721414ALE6M0_<盘序列号>
```

输出类似：

```text
dev-disk-by\x2did-ata\x2dHGST_HSH721414ALE6M0_<盘序列号>.device
```

然后创建服务：

```ini
# /etc/systemd/system/dm-zoned-hc620.service
[Unit]
Description=Activate dm-zoned mapping for HC620
Requires=dev-disk-by\x2did-ata\x2dHGST_HSH721414ALE6M0_<盘序列号>.device
After=dev-disk-by\x2did-ata\x2dHGST_HSH721414ALE6M0_<盘序列号>.device

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStartPre=/usr/sbin/modprobe dm-zoned
ExecStart=/usr/sbin/dmzadm --start /dev/disk/by-id/ata-HGST_HSH721414ALE6M0_<盘序列号>
ExecStop=/usr/sbin/dmzadm --stop /dev/disk/by-id/ata-HGST_HSH721414ALE6M0_<盘序列号>
```

这里不写 `[Install]`，也不执行 `systemctl enable dm-zoned-hc620.service`。服务由后面的 fstab 挂载单元按需启动，避免在硬盘未连接时被系统单独启动。

先手动启动一次映射，确认映射设备名称：

```bash
sudo systemctl start dm-zoned-hc620.service
ls -l /dev/mapper/
```

假设映射设备为：

```text
/dev/mapper/dmz-<盘序列号>
```

在映射设备上创建 ext4 文件系统，然后查询其文件系统 UUID：

```bash
sudo mkfs.ext4 -L HC620_DATA /dev/mapper/dmz-<盘序列号>
sudo blkid /dev/mapper/dmz-<盘序列号>
```

注意，这里需要记录的是 **dm-zoned 映射设备上 ext4 的 UUID**，不是原始 HC620 的设备路径或序列号。

创建挂载点：

```bash
sudo mkdir -p /mnt/hc620
```

随后在 `/etc/fstab` 中加入：

```fstab
UUID=<ext4文件系统UUID> /mnt/hc620 ext4 defaults,noatime,nofail,x-systemd.requires=dm-zoned-hc620.service,x-systemd.device-timeout=60s 0 2
```

各选项作用如下：

* `noatime`：读取文件时不更新访问时间，减少不必要的写入。
* `nofail`：硬盘未连接、映射失败或文件系统损坏时，不阻止系统继续启动。
* `x-systemd.requires=dm-zoned-hc620.service`：挂载前先启动 dm-zoned 映射服务，并等待服务成功完成。
* `x-systemd.device-timeout=60s`：最多等待映射设备出现 60 秒。
* 最后的 `0 2`：不做 dump，并允许在启动时对该非根 ext4 文件系统执行 fsck。

修改完成后重新载入 systemd 配置并测试：

```bash
sudo systemctl daemon-reload

# 如果当前已经挂载，先按正确顺序停止
sudo systemctl stop mnt-hc620.mount
sudo systemctl stop dm-zoned-hc620.service

# 只启动挂载单元，验证它能否自动拉起 dm-zoned 服务
sudo systemctl start mnt-hc620.mount
```

检查服务、映射和挂载状态：

```bash
systemctl status dm-zoned-hc620.service
systemctl status mnt-hc620.mount
dmsetup ls
findmnt /mnt/hc620
```

确认无误后再重启测试：

```bash
sudo reboot
```

重启后检查：

```bash
findmnt /mnt/hc620
systemctl status dm-zoned-hc620.service
journalctl -b -u dm-zoned-hc620.service
```

`dmzadm` 官方支持使用底层 zoned 设备执行 `--start` 和 `--stop`。默认安装路径为 `/usr/sbin/dmzadm`，但仍应以 `command -v dmzadm` 的实际输出为准。

性能实测：

顺序写 **98 MB/s**，顺序读 **148 MB/s**，兼容层对顺序流的损耗不大，与 btrfs 处于同一水平，均低于 f2fs 的满速。4K 随机写 **1.9 MB/s，约 456 IOPS**，平均延迟 17.5ms，**99 分位 139ms，长尾拖到秒级**（99.9 分位 514ms，最大 1.4s）。这是三个方案中唯一让真实随机写直接落盘的方案：写入直接进入常规区缓冲，不经过追加转换，机械盘随机写的物理规律全部生效。456 IOPS 对 7200 转硬盘而言已经不错（缓冲区域集中在盘首，寻道距离较短），但与追加转换方案相比仍有数量级的差距，延迟长尾也很明显。小文件方面，ext4 的页缓存路径表现正常：内核源码树解压 8.7 秒，删除加 sync 约 2 秒。按第十节的测试方法，180 秒的随机写全部落在 131 GiB 缓冲区之内，未触发大规模回收。回收发生时的性能衰减仅依据机制推断，未做实测。

## 7 方案二：btrfs zoned，原生支持但有功能限制

btrfs 从内核 5.12 起原生支持 zoned 模式，把块组（block group）直接对齐到 256MiB 的区上。写时复制（CoW）本身不做原地改写，与顺序写约束天然一致。这个方案不需要模拟层，也没有额外的数据搬运开销，是三个方案中最贴近盘本身工作方式的一种。

格式化只多一个 `-O zoned` 参数，但我的第一次尝试直接失败了。当时盘上还残留着上一任使用者的 f2fs 文件系统，卷标 happy_every_day，说明这块盘此前确实被当作 zoned 盘正常使用过。加 `-f` 强制格式化时，mkfs.btrfs 在 `Resetting device zones /dev/sda (52156 zones)` 阶段报 `failed to reset device zones: Input/output error` 后退出。

排查过程如下。手动对单个顺序写区发重置（`blkzone reset -o 274726912 -c 1`）成功。`blkzone reset /dev/sda` 全盘重置同样成功，仅耗时 2.5 秒，内核对整盘范围会走优化路径，即带 ALL 位的单条 RESET WRITE POINTER。重置后全盘扫描（`blkzone report | grep -vE "0\(nw\)|1\(em\)"`）未发现任何 read-only 或 offline 异常区。而 btrfs-progs 源码里 mkfs 的重置是**逐区**进行的，每个非空的顺序写区单独发一条 BLKRESETZONE。首次失败时盘上有 f2fs 数据和数千个非空区，失败就发生在这条长命令流中的某一处。单区重置与 ALL 位重置均正常，异常区为零，具体是哪条命令、为何失败，已无法确认。

实用结论：**对非空的二手盘，mkfs 之前先手动全盘重置**。这样既能绕开逐区重置的长命令流，也能把格式化失败与盘况问题解耦：

```bash
sudo apt install btrfs-progs
```

```bash
sudo blkzone reset /dev/sda           # 约 2.5 秒，一条命令重置全部顺序写区
sudo mkfs.btrfs -f -O zoned /dev/sda
sudo mount /dev/sda /mnt/hc620
```

预清空后 mkfs 一次通过，关键输出：

```
Zoned device:       yes
  Zone size:        256.00MiB
  Mode:             host managed
Sector size:        4096
Filesystem size:    12.73TiB
Number of devices:  1
  ID  SIZE      ZONES  PATH
   1  12.73TiB  52156  /dev/sda
```

使用前要清楚 zoned 模式的功能限制，这些限制都源于无法原地更新这个物理事实：

- `nodatacow` 不可用。没有 CoW 就意味着必须原地改写，物理上不允许，因此给虚拟机镜像或数据库关闭 CoW 这类常见做法在 zoned 模式下不可行。
- `fallocate` 预分配不可用，部分依赖它的软件（某些下载器、qBittorrent 的预分配选项）需要关闭相应功能。
- 多设备支持仍有限。较新内核配合 raid-stripe-tree 已支持 RAID0、RAID1 等部分配置，RAID5/6 仍不可用，具体能力高度依赖内核与 btrfs-progs 版本。本文只测试单盘，结论不要直接外推到阵列。
- 空间回收的逻辑是先把区内仍然有效的数据搬走，然后才能重置旧区再利用。较新的 btrfs 自带后台 zone reclaim 机制，也可以用 balance 主动整理 block group。长期运行需要持续观察区利用率、回收频率和写放大。

实测结果（方法与参数见第10节）：顺序写 20GiB 为 **104 MB/s**，带宽在 36–174 MiB/s 间波动，平均延迟 40ms。顺序读 20GiB 为 **154 MB/s**，与常规区的裸盘读速完全一致，文件系统层几乎无损耗。4K 随机写 180 秒为 **7.4 MB/s、约 1800 IOPS**，平均延迟 4.4ms，99 分位 9.9ms。内核源码树解压（约 8 万个小文件）7.7 秒，删除加 sync 约 8 秒。

随机写这个数字需要单独解释。7200 转机械盘的原地 4K 随机写物理上限大约是一两百 IOPS，这里测出 1800，是 CoW 在 zoned 模式下把随机写**全部转成顺序追加**的结果，盘自始至终处于顺序写状态。代价是延后的：每次改写都落在新位置，旧数据成为等待回收的垃圾，180 秒写入的 1.27GiB 全部是新分配。随机写越多，积累待回收的空间越大，随机写的性能优势和回收压力的累积来自同一个机制。

## 8 方案三：f2fs（日志结构文件系统）

f2fs 本身是日志结构（log-structured）文件系统，追加写入与垃圾回收是其原生工作方式，与顺序写区的约束一致。zoned 支持随 `CONFIG_BLK_DEV_ZONED` 自动编译，元数据放在盘首的常规区。容量方面需要注意，在常用的 4KiB 块大小与 32 位块寻址实现下，f2fs 单卷上限约 16TiB，14TB 型号格式化后的 12.7TiB 在上限之内，15TB 型号同样可以容纳。

```bash
sudo apt install f2fs-tools
sudo mkfs.f2fs -f -m /dev/sda    # -m 即 zoned 模式
sudo mount /dev/sda /mnt/hc620
```

mkfs.f2fs（f2fs-tools 1.16.0）在识别盘的过程中独立报出了与 blkzone 一致的布局，其中包括 524 个可随机写区，与第5节的常规区计数互相印证：

```
Info: Host-managed zoned block device:
      52156 zones, 268435456u zone size(bytes), 524 randomly writeable zones
      65536 blocks per zone
Info: Overprovision ratio = 0.450%
Info: Overprovision segments = 30103 (GC reserved = 29569)
```

挂载后自动启用 `mode=lfs`（严格日志结构写入，zoned 盘必需）、`active_logs=6` 和 `discard`。实测结果在三方案中最好。顺序写 **242 MB/s**，顺序读 **244 MB/s**，达到甚至略超官方标称值，具体成因见第10节的带宽分析。4K 随机写 **55.9 MB/s，约 1.36 万 IOPS**（99 分位延迟约 3ms），是 btrfs 的七倍以上。这一优势来自 `mode=lfs` 的追加写转换与多路活跃日志的批量提交机制。回收的代价同样可以直接观察到，随机写 180 秒后 `dirty_segments` 从 0 增长到 4099（约 8 GiB 待回收段），与写入量吻合。小文件负载是 f2fs 的弱项，内核源码树解压用时 42.0 秒，而 btrfs 只需 7.7 秒。删除加 sync 约 1.7 秒。

## 9 按需：zonefs

如果想直接使用 zone 这层抽象，内核还有一个极简的 zonefs：每个区暴露为一个文件，顺序写区的文件只能追加（append-only），删除内容等于重置区。它不是通用文件系统，而是给自研归档、日志类工具用的接口。需要时安装 `zonefs-tools`，用 `mkzonefs` 创建，此处不展开。

## 10 性能小结与适用场景

三个方案尽量采用一致的测试参数和空盘初始状态，以提高横向可比性。每次更换文件系统前执行 `blkzone reset` 全盘重置并重新 mkfs，从全空盘开始测试。fio 统一使用 `--direct=1 --ioengine=libaio`，顺序读写 `bs=1M iodepth=4 size=20G`，4K 随机写 `iodepth=8` 时间制 180 秒。另用解压内核源码树（约 8 万个小文件）测试真实元数据负载。注意 fio 必须加 `--fallocate=none`，fio 默认用 fallocate 预分配测试文件，在 btrfs zoned 上会直接失败，这与第7节所列的限制一致。裸盘顺序读基线（只读安全）分别测盘首与盘尾各 8G，用于验证外圈到内圈的速度衰减。但 zoned 盘在测量上有一个需要注意的问题：**空区（写指针之后）的读取不落盘**，由盘的电路直接返回零，测出的是 SATA 链路速度而不是盘片速度（实测空区读出 374MB/s，超出盘片的物理能力）。内圈基线必须先用 `fio --zonemode=zbd` 合法写入数据再读。随机写结果的解读要注意边界：dm-zoned 的短时随机写基本落在 131 GiB 常规区缓冲内，不触发大规模回收，数据仅代表缓冲未满时的表现。长期回收行为未纳入实测，只作机制层面的说明，受机械盘速度限制，这无法在一轮基准测试的时间内充分覆盖。

| 项目 | btrfs zoned | f2fs | dm-zoned + ext4 |
| --- | --- | --- | --- |
| 顺序写（20GiB，1MiB） | 104 MB/s | **242 MB/s** | 98 MB/s |
| 顺序读（20GiB，1MiB） | 154 MB/s | **244 MB/s** | 148 MB/s |
| 4K 随机写（180s） | 7.4 MB/s ≈ 1800 IOPS | **55.9 MB/s ≈ 13.6k IOPS** | 1.9 MB/s ≈ 456 IOPS |
| 随机写 99 分位延迟 | 9.9 ms | 约 3 ms | 139 ms（长尾至秒级） |
| 内核源码解压（约 8 万文件） | **7.7 s** | 42.0 s | 8.7 s |
| 删除 + sync | 约 8.2 s | 约 1.7 s | 约 2.0 s |

裸盘基线（fio 固定 1 MiB、direct）：常规区读 154 MB/s，内圈写/读约 116 MB/s。

三个方案各有侧重。**要吞吐和稳定的写延迟选 f2fs**，顺序写达到满速，随机写通过 lfs 追加转换获得数量级优势，代价是小文件性能较差和功能相对单薄。**要功能生态选 btrfs**，快照、校验、send/receive 俱全，小文件最快，顺序写性能有折损。**要兼容性选 dm-zoned**，上层是普通的 ext4，对软件没有特殊要求，但随机写是三者中唯一回落到机械盘物理水平的，长尾延迟高出一个数量级，且回收开销由设备映射层承担，而不是由文件系统承担。

带宽数据需要结合实测分析。裸盘基线为常规区读 154 MB/s、内圈写读约 116 MB/s，我最初将这一差距归因于关闭 NCQ 的代价。但 f2fs 随后跑出 **242/244 MB/s** 的顺序写读，达到甚至略超 14TB 型号官方典型持续传输率 233 MB/s（约 223 MiB/s，外圈较快、向内圈递减），说明这条链路在 noncq 下依然可以达到满速。裸设备基线只有 154 MB/s，而 f2fs 文件读写达到 242/244 MB/s，说明瓶颈并非 SATA 链路或关闭 NCQ 本身。差异可能与实际落盘 LBA、请求合并方式、文件系统提交模式以及测试文件的物理布局有关。本文没有通过 filefrag、blktrace 等手段进一步核对请求与物理位置，因此不对具体原因下确定结论。可以确认的是，在本文实际文件负载下，关闭 NCQ 并未限制顺序吞吐接近该盘的官方典型值。btrfs 顺序写 104 MB/s，存在较明显的额外开销。

场景判断：

**适合**：以大文件、批量、追加写为主的负载。媒体归档、一次写入长期保存的冷数据、备份仓库（restic、borg 的日常备份以追加写为主）。这类负载最容易发挥 HM-SMR 的优势，但"适合"不等于"全程无感"。备份工具的 prune、compact、重建索引阶段会产生删除和元数据改写，rsync 增量同步会改写既有文件，NVR 类软件可能频繁更新索引数据库。这些维护阶段的延迟和写放大需要单独测试评估，只测一轮全量上传是不够的。

**不适合**：用作日常 NAS 数据盘（家庭 NAS 的写入远比想象中随机）、BT 下载盘（大量乱序写+预分配）、数据库或虚拟机存储。dm-zoned 能让这些场景运行，但回收压力大时延迟波动会非常明显。

总结：**它的低价来自负载限制。负载匹配时性价比很高，不匹配时不建议购买。**

## 附录 A：Raspberry Pi OS 自编内核路线

如果这台 Pi 还要承担 Pi OS 生态绑定的任务（比如 libcamera/rpicam 摄像头栈），可以走自编内核路线。基于官方 defconfig 补上以下选项：

```
CONFIG_BLK_DEV_ZONED=y    # 必需，块层 zoned 支持，f2fs/btrfs 的 zoned 路径随之启用
CONFIG_DM_ZONED=m         # 按需，方案一 dm-zoned
CONFIG_ZONEFS_FS=m        # 按需，zonefs
```

流程与官方文档的内核编译指南一致：拉取 `raspberrypi/linux` 对应分支，执行 `make bcm2712_defconfig`，然后在 `menuconfig` 中启用上述选项（Enable the block layer → Zoned block device support；Device Drivers → Multiple devices driver support → Device mapper support → Drive-managed zoned block device target support；File systems → zonefs），最后编译安装。完整的编译与长期维护流程（交叉编译环境、config fragment 脚本化、独立内核名安装布局、一行回滚、跟版节奏）我会另文展开。

需要注意的是，**自编内核不在 apt 更新体系内**，但维护工作可以做得比每次更新后被动重编更有条理。推荐的做法是编译时用 `LOCALVERSION` 起独立版本名（如 `-zoned`），内核镜像安装为独立文件（如 `/boot/firmware/kernel-zoned.img`），并在 `config.txt` 里用 `kernel=kernel-zoned.img` 指定加载。这样官方内核更新只覆盖它自己的 `kernel_2712.img`，与自编内核互不干扰，系统其余部分可以照常 `apt full-upgrade`。维护由此变成主动决定跟版节奏，例如按月跟进一次，交叉编译约消耗二十分钟机器时间，config 改动固化成 fragment 加构建脚本即可。代价是两次跟版之间内核无法获得安全补丁，因此该方案适合内网存储机，不适合暴露面大的场景。另外需要排除一个看似可行的思路：DKMS 式的模块外挂并不存在。`CONFIG_BLK_DEV_ZONED` 是编入内核本体的块层核心选项，`dm-zoned` 和 `zonefs` 模块都依赖它，因此不存在不重编内核的替代路径。

```bash
# 或也可以尝试向上游提交 issue 或 PR，讨论是否适合在 Pi 5 默认配置中启用 zoned 支持，是否接受则取决于维护者对使用范围和内核配置成本的权衡。
```

## 附录 B：解决 Rust coreutils 的 AppArmor 日志刷屏

Ubuntu 26.04 将 coreutils 替换为 Rust 实现（uutils）。新实现下 `who` 等命令启动时会读取本地化目录 `/usr/share/coreutils/locales/`，而配套的 AppArmor profile 没有放行该路径，读取被拒绝后 `who` 没有任何输出。部分 SSH 客户端的远程监控栏每秒调用一次 `who`，每次调用都会写入一条 audit 记录，日志因此持续刷屏。解决方法是向该 profile 的 local 覆盖文件追加一条读取规则。使用 local 覆盖而不是直接修改 profile 本体，是因为软件包更新不会改动 local 文件，规则可以长期保留：

```bash
sudo apt update && sudo apt upgrade    # 先看是否已有官方修复
sudo aa-status | grep who              # 实测 profile 名即为 who
# Ubuntu 已为每个 profile 预置 local 覆盖文件，直接追加规则即可
echo "/usr/share/coreutils/locales/** r," | sudo tee -a /etc/apparmor.d/local/who
sudo apparmor_parser -r /etc/apparmor.d/who
who                                    # 应恢复正常输出，audit 不再新增
```

规则生效后 `who` 输出恢复正常，audit 日志停止刷屏。

## 附录 C：通过 SMB 共享给 Windows

归档盘只在树莓派本地读写不够方便，这一节用 Samba 把它共享出去，让 Windows 资源管理器直接访问。以下按正文的挂载点 `/mnt/hc620` 操作。

### C.1 固定挂载

共享服务要求盘在开机后自动就位。在 `/etc/fstab` 追加一行（UUID 用 `sudo blkid /dev/sda` 查询）：

```text
UUID=<UUID占位>  /mnt/hc620  btrfs  noatime,compress=zstd,nofail  0  0
```

`noatime` 省去纯读取触发的元数据回写，`compress=zstd` 能为归档数据节省一部分容量（照片、视频等本身已压缩的数据会自动跳过），`nofail` 保证盘不在位时系统照常启动。修改后执行 `sudo mount -a` 验证无报错。

### C.2 安装与共享配置

```bash
sudo apt install samba wsdd2
```

`wsdd2` 负责让共享出现在 Windows 的"网络"列表中。现代 Windows 已不再使用 NetBIOS 发现主机，缺少这个组件时共享功能本身正常，但在网络邻居中不可见，这是这套配置里最容易遗漏的一点。

创建共享目录并将属主改为当前用户：

```bash
sudo mkdir -p /mnt/hc620/archive
sudo chown $USER:$USER /mnt/hc620/archive
```

在 `/etc/samba/smb.conf` 末尾追加：

```ini
[archive]
   path = /mnt/hc620/archive
   read only = no
   inherit permissions = yes
```

设置 Samba 密码（与系统密码独立）并重启服务：

```bash
sudo smbpasswd -a $USER
sudo systemctl restart smbd wsdd2
```

### C.3 Windows 端访问

直接在地址栏输入：

```text
\\<树莓派主机名或 IP>\archive
```

凭据使用上一步的系统用户名和 Samba 密码。首次连接勾选"记住凭据"，之后可右键映射为网络驱动器。

![](https://img.gulugulublog.com/posts/hc620-hm-smr-raspberry-pi-5/20260724214056297.png)

注：Pi 5 连接无线网络下的传输速度

### C.4 使用方式

最后提醒一点：这块盘的正确使用方式是**整文件拷入、只读取出**，共享目录按归档用途使用即可。在共享上直接编辑文件、频繁原地改写，相当于沿用 CMR 盘的使用习惯对待 HM-SMR 加 CoW 文件系统的组合。这样做可以工作，但每次改写都会触发正文介绍过的整段 CoW 开销。

## 附录 D：定期 scrub 巡检

btrfs 的全数据校验和只在读取时验证，而归档数据的常态是写入后多年不再读取，静默腐坏可能一直潜伏到真正需要那个文件时才暴露。scrub 主动将已用空间完整读取一遍，逐块比对校验和，把被动的"读到才发现"变成主动的定期巡检。单盘没有冗余副本，scrub 无法修复损坏的数据，但会在内核日志中给出损坏文件的具体路径，趁源数据还在手里重新拷贝一份即可。只有发现得早，这个补救手段才成立。

两个文件加一条命令。

`/etc/systemd/system/btrfs-scrub-hc620.service`：

```ini
[Unit]
Description=Monthly btrfs scrub on HC620
ConditionPathIsMountPoint=/mnt/hc620

[Service]
Type=oneshot
ExecStart=/usr/bin/btrfs scrub start -B /mnt/hc620
```

`/etc/systemd/system/btrfs-scrub-hc620.timer`：

```ini
[Unit]
Description=Monthly btrfs scrub timer for HC620

[Timer]
OnCalendar=monthly
Persistent=true
RandomizedDelaySec=1h

[Install]
WantedBy=timers.target
```

启用：

```bash
sudo systemctl enable --now btrfs-scrub-hc620.timer
systemctl list-timers btrfs-scrub-hc620.timer   # 确认下次触发时间
```

几个参数各有用途。`-B` 让 scrub 在前台运行，service 的退出状态才等于巡检结果，用 `systemctl status btrfs-scrub-hc620.service` 即可确认上次巡检是否发现错误。`ConditionPathIsMountPoint` 在盘未挂载时静默跳过，与附录 C 挂载参数里的 `nofail` 配套，盘不在位时系统不会报错。`Persistent=true` 用于补跑关机期间错过的计划，`RandomizedDelaySec` 把触发时间错开整点，避免集中负载。

查看结果：

```bash
sudo btrfs scrub status /mnt/hc620   # 上次进度、耗时、错误计数
sudo dmesg | grep -i "checksum error"   # 有错误时含具体文件路径
```

耗时量级：scrub 顺序读取全部已用空间，按本盘外圈两百余、内圈一百余 MB/s 的读速估算，每 1TB 数据约需一小时出头，写满后全盘一轮需要十几到二十小时，这是巡检频率定为每月而非每周的原因。巡检期间盘保持正常可用，读性能会被分走一部分。
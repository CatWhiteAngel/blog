---
title: Ultrastar DC HC620 分析与实战——树莓派 5 驱动主机管理式 SMR 硬盘
date: 2026-07-16 16:01:00
categories: [Hardware]
tags: [Raspberry Pi, SMR, Storage, Linux]
description: 西数 Ultrastar DC HC620 是主机管理式 SMR（HM-SMR）硬盘，在 Windows 或未启用 zoned 块设备支持的 Linux 内核中无法正常作为块设备使用，二手价因此便宜到离谱。本文分析 HM-SMR 的原理与限制，并用树莓派 5 加 PCIe 转 SATA 扩展板把它完整跑起来：系统选择、内核支持验证、zone 勘察，以及 dm-zoned、btrfs zoned、f2fs 三种文件系统方案的实测对比。
---

# Ultrastar DC HC620 分析与实战——树莓派 5 驱动主机管理式 SMR 硬盘

如果你在二手平台搜过大容量机械盘，大概率见过这样的商品：西数（HGST）Ultrastar DC HC620，14TB，氦气企业盘，价格却比同容量的普通企业盘低一大截，商品描述里往往带一句语焉不详的"需专用系统"或"不支持普通电脑"。便宜不是因为盘有问题，而是因为它属于**主机管理式叠瓦盘（Host-Managed SMR，HM-SMR）**，插进 Windows 不认；插进未启用 zoned 块设备支持的 Linux 内核，`lsblk` 里连盘符都不会出现，而树莓派官方系统的内核恰恰属于后者。绝大多数买家用不了，二手价格因此偏低。

但"系统不支持"和"不能用"是两回事。Linux 从 4.10 起加入分区块设备（Zoned Block Device）的核心支持，dm-zoned、zonefs、btrfs zoned 等组件在后续版本中陆续补齐。本文用一块 14TB 的 HC620、一台树莓派 5 和一块 PCIe 转 SATA 扩展板。

这套方案适合**冷备份、顺序归档、一次写入多次读取**的场景，顺序读写可以逼近盘的标称上限（233 MB/s）。它**不适合**当普通 NAS 数据盘、下载盘或任何随机写密集的用途，即便套上 dm-zoned 这样的兼容层也只是"能用"而不是"好用"。如果需求是一块省心的仓库盘，应当加钱买 CMR。

## 1 SMR 四象限：先搞清楚你买的是什么

机械盘按记录方式和管理方式可以分成四类，买二手大容量盘之前必须能分清：

**CMR（Conventional Magnetic Recording，传统垂直记录）**。磁道互不重叠，任意扇区可随机改写，就是"普通硬盘"。

**DM-SMR（Drive-Managed SMR，盘管理式叠瓦）**。磁道部分重叠以换取密度（shingled 即瓦片式堆叠之意），改写一条磁道必须重写一整片。盘内固件在内部处理这些重写，对系统表现为普通盘；代价是缓存写满后性能大幅下降。消费级低价大容量盘的性能问题多出在这一类，且系统层面无法直接识别，只能查型号。

**HA-SMR（Host-Aware SMR，主机感知式）**。介于两者之间，既接受随机写也暴露 zone 接口，市面上很少见。

**HM-SMR（Host-Managed SMR，主机管理式）**。不做任何伪装，把叠瓦结构以"区（zone）"的形式直接暴露给主机，通过 ZBC（SCSI）/ ZAC（ATA）命令集管理，**只接受符合规则的顺序写入**，违规写入直接报 I/O 错误。数据中心用它换取可预测的性能和最高的密度，HC620 就是这一类，也是唯一一类"插上去盘符不出现"的。

识别方法按实用程度排序：最可靠的是查型号，HC620 的 SATA 型号为 `HSH721414ALE6M0`（14TB、512e）、`HSH721414ALN6M0`（14TB、4Kn）及对应的 15TB 型号 `HSH721415ALE6M0` / `HSH721415ALN6M0`，型号里的 `HSH` 开头基本就是这个家族；其次看商品页关键词，"host managed"、"主机管理"、"需专用系统/服务器"、"不支持个人电脑"都是信号；最后，盘到手后在支持 zoned 的系统上一条命令定性：

```bash
cat /sys/block/sda/queue/zoned
# host-managed → HM-SMR
# host-aware   → HA-SMR
# none         → CMR 或 DM-SMR（DM-SMR 对系统不可见，只能查型号）
```

{% note warning %}
买之前确认接口是 **SATA**。HC620 有 SATA 和 SAS 两种接口，SAS 版往往更便宜，但本文的 PCIe 转 SATA 方案带不动 SAS 盘，需要 SAS HBA，功耗和体积都是另一个量级，不在本文范围内。
{% endnote %}

## 2 HC620 是一块什么盘

基本规格：3.5 寸、7200 RPM、氦气封装（HelioSeal 第四代）、512MB 缓存、官方标称最高持续传输率 233 MB/s（223 MiB/s，外圈值，向内圈递减；实测见后文）、额定年写入负载 550TB、MTBF 250 万小时。2018 年发布时，15TB 型号是全球第一块 15TB 企业盘。

真正决定用法的是它的 zone 布局。整块盘的地址空间被切成一个个 **256 MiB 的区**，分两种：

- **常规区（Conventional Zone）**：位于盘的开头，容量占比很小（15TB 型号实测为 130GiB 出头），可以随机读写，行为和普通硬盘无异。后面会看到，dm-zoned 和 f2fs 的元数据都放在这部分常规区。
- **顺序写区（Sequential Write Required Zone）**：剩下的全部。每个区维护一个**写指针（Write Pointer）**，写入必须精确落在写指针位置并顺序推进；想改写已有数据，只能把整个区**重置（Reset）**后从头再写。随机读不受限制。

具体到容量：14TB 512e 型号共 52156 个区（每区 524288 个 512B 逻辑块），15TB 4Kn 型号共 55880 个区（每区 65536 个 4K 逻辑块），都是 256 MiB。这个数字后面 `blkzone report` 时可以核对。

512e（`ALE`）和 4Kn（`ALN`）型号在本文方案下都能用，物理扇区都是 4K，区别只在逻辑扇区大小。二手市场 512e 更常见，本文以 14TB 512e 为例。

到手检测和普通企业盘一样，`smartctl` 完全正常工作，重点看通电时间、`Reallocated_Sector_Ct` 和 UDMA CRC 错误。注意 Ubuntu Server 没有预装 smartmontools：

```bash
sudo apt install smartmontools
sudo smartctl -a /dev/sda
```

本盘实测关键字段：整体评估 PASSED；**通电 55441 小时（约 6.3 年）**，`Reallocated_Sector_Ct`、`Current_Pending_Sector`、`Offline_Uncorrectable`、`UDMA_CRC_Error_Count` 全部为 0，`Helium_Level` 100，盘温 36°C。

数据中心退役盘通电数万小时是常态，判断健康看缺陷计数和氦气水平而非使用时长——这块盘跑了六年多，各项指标依然全绿。smartctl 会提示 `Device is: Not in smartctl database`，HC620 不在其识别库中，属正常现象，不影响属性读取。

## 3 硬件准备

**必需：**

- 树莓派 5（内存不敏感，2GB 起步即可；本文实测机为 8GB 版本）
- PCIe 转 SATA 扩展板。本文用的是微雪 **PCIe TO 2-CH SATA HAT+**（约 100 元，含 16PIN FPC 排线、SATA 数据电源一体线和铜柱），实测主控为 ASMedia **ASM1061/1062**（PCI ID `1b21:0612`），双 SATA 口，PCIe 2.0 x1。选型的关键不是具体芯片而是**必须走 AHCI**：ZAC 命令要经内核 libata 层原生传递，ASM1061/JMB582/JMB585/ASM1166 这类 AHCI 控制器都满足。多数 USB-SATA 桥接方案无法透传所需的 zone 管理命令，除非产品明确声明支持相关 ZAC/ZBC 命令透传，因此本文不建议使用 USB-SATA 硬盘盒。ASM1061 与 HM-SMR 组合可能存在 NCQ 兼容性问题，可解决但要修改内核参数，详见第5节。预算允许的话选 JMB585/ASM1166 等更新的方案可能省事一些。
- 12V 电源。这块扩展板带 12V DC（**4.0mm * 1.7mm**）输入并板载 5V/12V 硬盘供电，是选它的另一个理由——3.5 寸盘的 12V 是树莓派自身给不了的。启动瞬间 12V 电流普遍在 2A 上下，单盘按 ≥3A 留余量，双盘再翻倍。
- HC620 本体（SATA 版）

**可选：**硬盘支架或减震垫（7200 转企业盘的震动和噪音比桌面盘明显）、给 SATA 主控芯片贴的小散热片。

```bash
lspci -nn
```

```
0001:00:00.0 PCI bridge [0604]: Broadcom Inc. and subsidiaries BCM2712 PCIe Bridge [14e4:2712] (rev 21)
0001:01:00.0 SATA controller [0106]: ASMedia Technology Inc. ASM1061/ASM1062 Serial ATA Controller [1b21:0612] (rev 02)
0002:00:00.0 PCI bridge [0604]: Broadcom Inc. and subsidiaries BCM2712 PCIe Bridge [14e4:2712] (rev 21)
0002:01:00.0 Ethernet controller [0200]: Raspberry Pi Ltd RP1 PCIe 2.0 South Bridge [1de4:0001]
```

SATA 控制器识别为 ASMedia ASM1061/1062，class 0106 即标准 AHCI，可用。顺带能看到 Pi 5 的板载千兆网卡走的是另一条 PCIe 链路（RP1 South Bridge），和扩展板互不挤占。

组装没什么特别的：FPC 排线连接 Pi 5 的 PCIe 接口和扩展板（注意排线两端锁扣方向），一体线接盘，12V 电源接扩展板 DC 口。然后在 `/boot/firmware/config.txt` 启用外部 PCIe（**机器相关**：较新固件检测到设备会自动启用）：

```ini
dtparam=pciex1
# ASM1061/1062 是 PCIe 2.0 设备，链路只会协商到 Gen2 x1（约 500MB/s）
# 对这块板设置 dtparam=pciex1_gen=3 没有意义；单盘机械盘也远用不满 Gen2 带宽
```

## 4 系统选择：为什么原版系统不行

这是全文最重要的一节。HM-SMR 盘要被内核识别为块设备，内核必须启用 `CONFIG_BLK_DEV_ZONED`（分区块设备支持，Zoned Block Device）。这个选项启用后，SCSI 子系统对 ZBC/ZAC 盘的支持、f2fs 的 zoned 支持会自动跟着开启；dm-zoned 和 zonefs 则还需要各自的选项。

问题在于：**Raspberry Pi OS 的官方内核至少在本文核对的 rpi-6.12.y 和 rpi-6.18.y 分支中，Pi 5 使用的 bcm2712_defconfig 均未启用这些选项。** 在这两个分支的 arch/arm64/configs/bcm2712_defconfig 中，CONFIG_BLK_DEV_ZONED、CONFIG_DM_ZONED 和 CONFIG_ZONEFS_FS 均未启用。后果是 HC620 接上后，内核在 `sd_probe` 阶段直接放弃这块盘，`dmesg` 里只留下一行：

```
sd 0:0:0:0: Unsupported ZBC host-managed device.
```

盘"消失"了——`lsblk` 看不到，`/dev/sda` 不存在。

实测于 Raspberry Pi OS（内核 6.18.34+rpt-rpi-2712）：

```
[    1.578469] scsi 0:0:0:0: Direct-Access-ZBC ATA      HGST HSH721414AL T10B PQ: 0 ANSI: 7
[    1.578658] sd 0:0:0:0: Unsupported ZBC host-managed device.
```

内核认出了这是 ZBC 设备，然后在下一行放弃了它；`lsblk` 里只有 SD 卡，盘不存在。

出路有两条：给 Pi OS 自编内核（见附录 A），或者换用内核默认带 zoned 支持的发行版。我最终选择了 **Ubuntu Server 26.04 LTS（64-bit，树莓派镜像）** 作为主线，理由很简单：这台机器建成后是 7×24 的存储机，自编内核意味着每次 `apt` 更新内核都要重编一遍，或者永久 hold 内核包放弃安全更新。Ubuntu 的 `linux-raspi` 内核由 apt 正常维护，zoned 支持不会因为更新而丢失。26.04 基于内核 7.0，zoned 生态相关的代码也足够新。

烧写直接在 Raspberry Pi Imager 里选 Other general-purpose OS → Ubuntu → **Ubuntu Server 26.04 LTS (64-bit)**，用户名、SSH 都可以在 Imager 的预配置里填好。但 Wi-Fi 预配置在 Ubuntu Server 上首启不可靠（cloud-init 应用无线配置的时机偏晚，常见表现为首次开机连不上、重启一次才正常；5GHz SSID 受首启国家码未生效影响更容易失败），这台机器反正是常开的存储机，**首启建议直接插网线**，无线等系统起来后再用 netplan 配置或干脆不配。还有一个 26.04 特有的情况：按官方发布说明，这一版树莓派镜像因新的启动流程（A/B 启动布局），**要求 Pi 5 的 EEPROM 固件日期不早于 2025-02-11**，过旧的固件可能无法启动该镜像。如果你的 Pi 5 库存了一阵子，先在任意能启动的系统里跑：

```bash
sudo rpi-eeprom-update      # 查看当前固件日期
sudo rpi-eeprom-update -a   # 过旧则升级，然后重启
```

实测本机固件日期为 2025-05-08，满足要求，无需操作（Ubuntu 上 `rpi-eeprom-update` 由 `rpi-eeprom` 包提供，可直接使用）。

系统启动后第一件事，验证内核配置（**这一步的结果决定你要不要看附录 A**）：

```bash
grep -E "BLK_DEV_ZONED|DM_ZONED|ZONEFS" /boot/config-$(uname -r)
```

```
CONFIG_BLK_DEV_ZONED=y
CONFIG_BLK_DEV_ZONED_LOOP=m
CONFIG_DM_ZONED=m
CONFIG_ZONEFS_FS=m
```

四项全部齐备（实测于 26.04 的 `linux-raspi` 内核 7.0.0-1009-raspi）：块层 zoned 支持直接编进内核，dm-zoned 和 zonefs 以模块提供，本文三种文件系统方案都不需要动内核。作为对照，同一台 Pi 5 换 Raspberry Pi OS 的卡跑同一条命令，结果是 `# CONFIG_BLK_DEV_ZONED is not set`。

顺手确认两个环境事实，后文实测会引用：

```bash
uname -r            # 实测：7.0.0-1009-raspi
getconf PAGE_SIZE   # 实测：4096
```

## 5 识盘与 zone 勘察

在带 zoned 支持的内核上，接盘上电。查看内核日志建议用 `journalctl -k -b` 而不是 `dmesg`：内核环形缓冲区容量有限，一旦有刷屏内容（比如附录 B 里那个 AppArmor audit 问题），开机阶段的识盘信息会被挤出缓冲区，`dmesg` 就什么都查不到了，journal 则保存本次启动的完整内核日志。

```bash
sudo journalctl -k -b | grep -iE "ahci|ata[0-9]|sd[a-z]|zbc"
```

我这台机器的实测输出如下，暴露了一个扩展板兼容性问题（节选）：

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

时间线：链路正常协商到 6.0 Gbps，内核认出这是 ZBC 设备，但第一条 REPORT ZONES（读取 zone 布局的命令）被盘中止，容量读成 0；libata 反复重试后**自动禁用 NCQ**，之后同样的命令立即成功，容量和区数（52156 个，与文献值一致）全部读出。整个收敛过程约一分钟。这个序列**每次开机都确定性复现**，逐行节奏一致——这也是排除接触不良、供电抖动等物理层原因的依据之一，物理层故障的特征是随机性，不会每次都精确死在同一条命令上。

证据强烈指向 **ASM1061 对 NCQ 编码 ZAC 命令的 AUX 字段处理有缺陷**，理由有三。其一，ZAC 的 zone 管理命令走 NCQ 路径时（RECEIVE/SEND FPDMA QUEUED）依赖 FIS 中的 AUX 字段，而内核 `drivers/ata/ahci.c` 对**所有** AHCI 控制器无条件启用该能力，源码注释原话是"All AHCI controllers should be forward-compatible with the new auxiliary field. This code should be conditionalized if any buggy AHCI controllers are encountered"——内核开发者自己预见了在有缺陷的控制器上会出现这类失败。其二，ASM1061 是 AHCI 1.2（日志中 `AHCI vers 0001.0200`）、2011 年的设计，早于 AUX 字段和 ZAC 规范数年，"向前兼容"假设在这类老芯片上最脆弱。其三，内核的盘型号 quirk 表中没有任何 HC620 条目，这盘在数据中心大规模部署多年，若固件 NCQ ZAC 有缺陷早该被列入黑名单了。日志特征基本不符合典型的供电或线材故障，现有证据高度指向 ASM1061 在 NCQ ZAC 命令处理上的兼容性问题。不过本文没有进行控制器 A/B 对照或协议级抓取，因此将其视为有充分依据的故障归因，而不是已经完全证明的芯片缺陷。

盘能用了，但不要每次开机都靠一分钟的错误重试收敛，把 NCQ 关闭固化到内核命令行。这里先要绕开一个 26.04 特有的坑：**顶层的 `/boot/firmware/cmdline.txt` 不是启动时实际读取的文件**。26.04 的 A/B 启动布局通过 `config.txt` 中的 `os_prefix=current/` 把固件指向槽位目录，内核、initrd、设备树和真正的 cmdline.txt 都在 `/boot/firmware/current/` 之下；改顶层那份不生效、也不报任何错。判断方法很简单：`cat /proc/cmdline` 看内核实际收到的参数，和你改的文件对不上，就说明改错了文件。正确做法：

```bash
grep os_prefix /boot/firmware/config.txt     # 确认当前槽位，通常为 current/
sudo sed -i 's/$/ libata.force=1.00:noncq/' /boot/firmware/current/cmdline.txt
cat /boot/firmware/current/cmdline.txt       # 确认仍为单行且参数在行尾
sudo reboot
```

`1.00` 指 ata1 端口设备 0，即本盘。重启后按序验证：

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

`FORCE: modified (noncq)` 是内核确认参数已应用；识盘从链路协商到读出全部 52156 个区在一秒内完成，全程无失败无重试。对比不加参数时约一分钟的错误收敛过程，这就是要固化参数的原因。`queue_depth` 确认为 1。

正常情况下，flash-kernel 会复制 current/cmdline.txt 生成新槽位的 new/cmdline.txt，因此手工添加的 libata.force=1.00:noncq 应当随内核更新保留。为避免更新流程或人工修改造成意外，每次内核更新后仍建议用 cat /proc/cmdline 复查。

性能上的代价：NCQ 主要优化并发随机读的排队，单流顺序读写基本不受影响——这块盘本来也只该跑顺序负载，可以接受。选购扩展板时如果想绕开这个问题，可以考虑更新的 JMB585/ASM1166 方案，但**任何 AHCI 控制器与 HM-SMR 的组合都建议以实测为准**。

接着从块层核对几个关键属性：

```bash
lsblk -z                                    # ZONED 列：host-managed，ZONE-NR 52156，ZONE-SZ 256M
cat /sys/block/sda/queue/zoned              # host-managed
cat /sys/block/sda/queue/nr_zones           # 实测：52156
cat /sys/block/sda/queue/chunk_sectors      # 实测：524288，即 256 MiB
cat /sys/block/sda/queue/scheduler          # 实测：none [mq-deadline]，默认即选中
```

`lsblk -z` 里还有两个值得认识的列：ZONE-OMAX 为 128，即盘允许同时处于打开状态的区数上限，zoned 文件系统的并发写入布局受它约束；ZONE-APP 32M 是内核为 SATA 盘模拟 Zone Append 的单次写入上限（6.10 起随 zone write plugging 提供，SATA ZAC 命令集本身没有 Zone Append）。

调度器这里有一条新老内核的分水岭：Linux 6.9 及以前，zoned 盘的顺序写约束依赖 **mq-deadline** 保证写命令不被重排，属于硬性要求。Linux 6.10 起块层引入了 zone write plugging，写入排序由块层原生处理，不再强制绑定某个调度器。本文主线的 26.04 是 7.0 内核，mq-deadline **已不是必需项**（实测默认调度器也恰好选中了它）。如果需要，固定方法是一条 udev 规则（可选）：

```bash
cat <<'EOF' | sudo tee /etc/udev/rules.d/99-zoned-scheduler.rules
ACTION=="add|change", KERNEL=="sd[a-z]", ATTR{queue/zoned}=="host-managed", ATTR{queue/scheduler}="mq-deadline"
EOF
```

然后用 util-linux 自带的 `blkzone` 查看盘的实际布局。盘首部的常规区和后面大量的顺序写区，以及每个区的写指针位置：

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

读法：`len 0x080000` 为 524288 扇区即 256 MiB；`wptr` 是**相对区起始的偏移量**，空区为 0；`zcond` 是区状态，常规区标 `0(nw)`（无写指针概念），空的顺序写区标 `1(em)`（empty）。常规区实测共 **524 个**（约 131 GiB），从盘首连续排布，至扇区 0x010600000 处切换为顺序写区。

这时候可以做一个实验，直接验证 HM-SMR 的写入约束。不要随手挑一个扇区号写——那样即使报错也无法确定原因。严谨的做法是先用 `blkzone report` 找一个空的顺序写区（`zcond: 1(em)`），其写指针位于区起始处，然后**故意跳过写指针**往区中间写，让失败原因唯一指向写指针规则。以本盘第一个顺序写区（起始扇区 0x010600000 = 274726912）为例，向区内偏移 1 MiB（2048 扇区）处写入：

```bash
# 危险操作，仅在空盘上实验
sudo blkzone report /dev/sda | grep -m3 SEQ
sudo dd if=/dev/zero of=/dev/sda bs=512 count=8 seek=274728960 oflag=direct
```

```
dd: IO error: Input/output error
```

写入没有落在写指针上，盘按 ZAC 规范拒绝执行。普通文件系统（ext4、xfs、NTFS）的元数据更新全是这种原地改写，这就是它们不能直接格在这块盘上的原因，也是接下来三种方案要解决的问题。

## 6 方案一：dm-zoned —— 模拟成普通块设备

dm-zoned 是内核 device mapper 的一个目标（target），思路是：用盘开头的常规区做随机写缓冲和元数据区，把整块盘向上模拟成一个**无写入约束的普通块设备**，后台执行"缓冲区 → 顺序区"的搬运回收。上层可以直接格式化 ext4 使用。

代价也写在原理里：随机写全部先落在那 100 多 GiB 的常规区里，写多了触发回收，性能会明显波动，模拟层还要吃掉一部分容量做元数据。它是三个方案里**兼容性最好、使用成本最低**的，适合只需要一块可正常挂载的大容量盘的场景。

用户态工具 `dmzadm` 来自 dm-zoned-tools，Ubuntu 没有打包，需要自行编译（依赖以仓库 README 为准）：

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
sudo dmzadm --format /dev/sda --force   # 注意 dmzadm 的选项必须放在设备参数之后；盘上有旧文件系统残留时需 --force
sudo dmzadm --start /dev/sda
ls /dev/mapper/
```

`--force` 的原因：`blkzone reset` 只重置顺序写区，**常规区的数据不受影响**。上一个文件系统放在常规区里的超级块会一直残留，所以本文这样连续换方案时，每次格式化都会检测到前一个文件系统，加 force 属正常操作。反过来这也意味着 reset 并不能"擦干净"整块盘，真要全盘清除需对常规区另行覆写。

实测 format 过程：报告 52156 个区的布局后重置全部顺序写区，写入**两套互为备份的元数据**（主集在块 0，副集在块 131072，各含映射表与位图），随后 `--start` 建立映射。映射设备名为 `dmz-<盘序列号>`。

之后按常规流程，把 `/dev/mapper/dmz-<盘序列号>` 当普通盘用：

```bash
sudo mkfs.ext4 /dev/mapper/dmz-<盘序列号>
sudo mount /dev/mapper/dmz-<盘序列号> /mnt/hc620
```

开机自动化要注意顺序：必须先执行 `dmzadm --start` 创建映射设备，再检查并挂载映射设备上的 ext4 文件系统。不要只把 `/dev/mapper/dmz-*` 直接写进 fstab，否则启动早期映射设备尚未出现，挂载会失败。

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

这里不写 `[Install]`，也不执行 `systemctl enable dm-zoned-hc620.service`。服务由后面的 fstab 挂载单元按需启动，避免它在硬盘未连接时仍被系统独立拉起。

先手动启动一次映射，确认映射设备名称：

```bash
sudo systemctl start dm-zoned-hc620.service
ls -l /dev/mapper/
```

假设映射设备为：

```text
/dev/mapper/dmz-<盘序列号>
```

在映射设备上创建 ext4 文件系统后，查询其文件系统 UUID：

```bash
sudo mkfs.ext4 -L HC620_DATA /dev/mapper/dmz-<盘序列号>
sudo blkid /dev/mapper/dmz-<盘序列号>
```

注意这里需要记录的是 **dm-zoned 映射设备上 ext4 的 UUID**，不是原始 HC620 的设备路径或序列号。

创建挂载点：

```bash
sudo mkdir -p /mnt/hc620
```

随后在 `/etc/fstab` 中加入：

```fstab
UUID=<ext4文件系统UUID> /mnt/hc620 ext4 defaults,noatime,nofail,x-systemd.requires=dm-zoned-hc620.service,x-systemd.device-timeout=60s 0 2
```

各选项作用如下：

* `noatime`：不因读取文件而更新访问时间，减少不必要的写入；
* `nofail`：硬盘未连接、映射失败或文件系统损坏时，不阻止系统继续启动；
* `x-systemd.requires=dm-zoned-hc620.service`：挂载前先启动 dm-zoned 映射服务，并等待服务成功完成；
* `x-systemd.device-timeout=60s`：最多等待映射设备出现 60 秒；
* 最后的 `0 2`：不使用 dump，并允许在启动时对该非根 ext4 文件系统执行 fsck。

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

`dmzadm` 官方支持使用底层 zoned 设备执行 `--start` 和 `--stop`；默认安装路径为 `/usr/sbin/dmzadm`，但仍应以 `command -v dmzadm` 的实际输出为准。


性能实测：

实测结果：顺序写 **98 MB/s**、顺序读 **148 MB/s**——兼容层对顺序流的损耗不大（与 btrfs 同一梯队，均低于 f2fs 的满速）；4K 随机写 **1.9 MB/s、约 456 IOPS**，平均延迟 17.5ms，**99 分位 139ms，长尾拖到秒级**（99.9 分位 514ms，最大 1.4s）。这是三方案中唯一"真随机写"落盘的：写入直接进入常规区缓冲，不做追加转换，机械盘随机写的物理规律全数生效，456 IOPS 对 7200 转的盘来说已经不差（缓冲区域集中在盘首、寻道短程），但和追加转换方案的数量级差距与延迟长尾摆在那里。小文件方面 ext4 的页缓存路径表现正常：内核源码树解压 8.7 秒，删除加 sync 约 2 秒。按第十节方法论所述，180 秒的随机写全部落在 131 GiB 缓冲之内，未触发大规模回收，回收发生时的性能衰减以机制推断为准，未做实测。

## 7 方案二：btrfs zoned —— 原生支持，但有功能限制

btrfs 从内核 5.12 起原生支持 zoned 模式，把块组（block group）直接对齐到 256MiB 的区上，写时复制（CoW）本身就不做原地改写，与顺序写约束天然一致。没有模拟层，没有额外的搬运开销，是三个方案里最原生的一种。

格式化只多一个 `-O zoned` 参数，但我的第一次尝试直接失败了。当时盘上还残留着前任使用者的 f2fs 文件系统（卷标 happy_every_day——侧面说明这块盘退役流转后曾被人正确地当 zoned 盘用过），加 `-f` 强制格式化，mkfs.btrfs 在 `Resetting device zones /dev/sda (52156 zones)` 阶段报 `failed to reset device zones: Input/output error` 退出。

排查：手动对单个顺序写区发重置（`blkzone reset -o 274726912 -c 1`）成功；`blkzone reset /dev/sda` 全盘重置成功且仅耗时 2.5 秒（内核对整盘范围走优化路径，即带 ALL 位的单条 RESET WRITE POINTER）；重置后全盘扫描（`blkzone report | grep -vE "0\(nw\)|1\(em\)"`）无任何 read-only/offline 异常区。而 btrfs-progs 源码里 mkfs 的重置是**逐区**进行的，非空的顺序写区每个单发一条 BLKRESETZONE。首次失败时盘上有 f2fs 数据、数千个非空区，失败发生在这条漫长命令流的某一处。单发与 ALL 位重置均正常、异常区为零，具体哪条命令为何失败已不可考。

实用结论：**对非空的二手盘，mkfs 之前先手动全盘重置**，既绕开逐区重置的长命令流，也把格式化失败与盘况问题解耦：

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

但要清楚 zoned 模式有哪些功能限制，这些限制源于"无法原地更新"这个物理事实：

- `nodatacow` 不可用，没有 CoW 就意味着原地改写，物理上不允许。因此"给虚拟机镜像或数据库关 CoW"这类常见做法在 zoned 模式下不可用。
- `fallocate` 预分配不可用，部分依赖它的软件（某些下载器、qBittorrent 的预分配选项）需要关掉相应功能。
- 多设备支持仍有限：较新内核配合 raid-stripe-tree 已支持 RAID0、RAID1 等部分配置，RAID5/6 仍不可用，且具体能力高度依赖内核与 btrfs-progs 版本。本文只测试单盘，结论不要直接外推到阵列。
- 空间回收的逻辑是：把区里仍然有效的数据搬走，才能重置旧区再利用。较新的 btrfs 自带后台 zone reclaim 机制，也可以用 balance 主动整理 block group；长期运行要观察区利用率、回收频率和写放大。

实测结果（方法与参数见第10节）：顺序写 20GiB 为 **104 MB/s**（带宽在 36–174 MiB/s 间波动，平均延迟 40ms）；顺序读 20GiB 为 **154 MB/s**，与常规区的裸盘读速完全一致，文件系统层几乎无损耗；4K 随机写 180 秒为 **7.4 MB/s、约 1800 IOPS**，平均延迟 4.4ms、99 分位 9.9ms；内核源码树解压（约 8 万个小文件）7.7 秒，删除加 sync 约 8 秒。

随机写这个数字要单独解释：7200 转机械盘的原地 4K 随机写物理上限约一两百 IOPS，这里跑出 1800，是 CoW 在 zoned 模式下把随机写**全部转成顺序追加**的结果，盘自始至终在做它擅长的事。代价是延后的：每次"改写"都落在新位置，旧数据成为垃圾等待回收，180 秒写入的 1.27GiB 全部是新分配。随机写越多，欠下的回收债越多，"随机写快"与"回收债累积"是同一枚硬币的两面。

## 8 方案三：f2fs —— 日志结构文件系统

f2fs 本身是日志结构（log-structured）文件系统，追加写加垃圾回收就是它原本的工作方式，与顺序写区的约束一致。zoned 支持随 `CONFIG_BLK_DEV_ZONED` 自动编译，元数据放在盘首的常规区。容量方面需要注意：在常用的 4KiB 块大小与 32 位块寻址实现下，f2fs 单卷上限约 16TiB，14TB（12.7TiB）刚好塞得下，15TB 型号也没问题。

```bash
sudo apt install f2fs-tools
sudo mkfs.f2fs -f -m /dev/sda    # -m 即 zoned 模式
sudo mount /dev/sda /mnt/hc620
```

mkfs.f2fs（f2fs-tools 1.16.0）对盘的识别中独立报出了与 blkzone 一致的布局，包括 524 个可随机写区，与第5节的常规区计数互为印证：

```
Info: Host-managed zoned block device:
      52156 zones, 268435456u zone size(bytes), 524 randomly writeable zones
      65536 blocks per zone
Info: Overprovision ratio = 0.450%
Info: Overprovision segments = 30103 (GC reserved = 29569)
```

挂载后自动启用 `mode=lfs`（严格日志结构写入，zoned 盘必需）、`active_logs=6`、`discard`。实测结果是三方案中的惊喜：顺序写 **242 MB/s**、顺序读 **244 MB/s**，达到甚至略超官方标称值，成因见第10节的带宽分析；4K 随机写 **55.9 MB/s、约 1.36 万 IOPS**（99 分位延迟约 3ms），是 btrfs 的七倍以上，`mode=lfs` 的追加写转换配合多路活跃日志的批量提交效率极高。回收债同样看得见：随机写 180 秒后 `dirty_segments` 从 0 涨到 4099（约 8 GiB 待回收段），与写入量吻合。小文件负载是它的弱项：内核源码树解压 42.0 秒，btrfs 只需 7.7 秒；删除加 sync 约 1.7 秒。

## 9 按需：zonefs

如果想直接使用 zone 这层抽象，内核还有一个极简的 zonefs：每个区暴露为一个文件，顺序写区的文件只能追加（append-only），删除内容等于重置区。它不是通用文件系统，而是给自研归档、日志类工具用的接口。需要时安装 `zonefs-tools`，用 `mkzonefs` 创建，此处不展开。

## 10 性能小结与适用场景

三个方案尽量采用一致的测试参数和空盘初始状态，以提高横向可比性。每次换文件系统前 `blkzone reset` 全盘重置后重新 mkfs，从全空盘起跑；fio 统一 `--direct=1 --ioengine=libaio`，顺序读写 `bs=1M iodepth=4 size=20G`，4K 随机写 `iodepth=8` 时间制 180 秒；另用解压内核源码树（约 8 万个小文件）测真实元数据负载。注意 fio 必须加 `--fallocate=none`，fio 默认用 fallocate 预分配测试文件，在 btrfs zoned 上会直接失败，正是第7节所列限制的现场例证。裸盘顺序读基线（只读安全）分别测盘首与盘尾各 8G，验证外圈到内圈的速度衰减，但注意 zoned 盘的一个测量陷阱：**空区（写指针之后）的读取不落盘**，由盘的电路直接返回零，测出来的是 SATA 链路速度而不是盘片速度（实测空区"读"出 374MB/s，远超物理可能）。内圈基线必须先用 `fio --zonemode=zbd` 合法写入数据再读。随机写结果的解读要注意边界：dm-zoned 的短时随机写基本落在 131 GiB 常规区缓冲内，不触发大规模回收，数据仅代表缓冲未满时的表现；长期回收行为以机制说明代替实测，机械盘的速度决定了那不是一轮基准能覆盖的。

| 项目 | btrfs zoned | f2fs | dm-zoned + ext4 |
| --- | --- | --- | --- |
| 顺序写（20GiB，1MiB） | 104 MB/s | **242 MB/s** | 98 MB/s |
| 顺序读（20GiB，1MiB） | 154 MB/s | **244 MB/s** | 148 MB/s |
| 4K 随机写（180s） | 7.4 MB/s ≈ 1800 IOPS | **55.9 MB/s ≈ 13.6k IOPS** | 1.9 MB/s ≈ 456 IOPS |
| 随机写 99 分位延迟 | 9.9 ms | 约 3 ms | 139 ms（长尾至秒级） |
| 内核源码解压（约 8 万文件） | **7.7 s** | 42.0 s | 8.7 s |
| 删除 + sync | 约 8.2 s | 约 1.7 s | 约 2.0 s |

裸盘基线（fio 固定 1 MiB、direct）：常规区读 154 MB/s，内圈写/读约 116 MB/s。

三方案各擅一场：**要吞吐和稳定的写延迟选 f2fs**，顺序满速、随机写靠 lfs 追加转换拉出数量级优势，代价是小文件慢和相对单薄的功能；**要功能生态选 btrfs**，快照、校验、send/receive 俱全，小文件最快，顺序写有折损；**要兼容性选 dm-zoned**，上层就是普通 ext4，什么软件都能跑，但随机写是三者中唯一回归机械盘物理现实的，长尾延迟差一个数量级，且回收债由映射层背而不是文件系统背。

带宽账落到实测，而且有一个反转。裸盘基线（fio 固定 1 MiB、direct）为常规区读 154 MB/s、内圈写读约 116 MB/s，一度让我把差距归因于关闭 NCQ 的代价——直到 f2fs 跑出 **242/244 MB/s** 的顺序写读，达到甚至略超 14TB 型号官方典型持续传输率 233 MB/s（约 223 MiB/s，外圈较快、向内圈递减），证明这条链路在 noncq 下依然能满速。裸设备基线只有 154 MB/s，而 f2fs 文件读写达到 242/244 MB/s，说明瓶颈并非 SATA 链路或关闭 NCQ 本身。差异可能与实际落盘 LBA、请求合并方式、文件系统提交模式以及测试文件的物理布局有关。由于本文没有通过 filefrag、blktrace 等手段进一步核对请求与物理位置，因此不对具体原因作确定结论。可以确认的是，在本文实际文件负载下，关闭 NCQ 并未阻止顺序吞吐接近该盘的官方典型值。btrfs 顺序写 104 MB/s，表现出较明显的额外开销。

场景判断：

**适合**：以大文件、批量、追加写为主的负载。媒体归档、一次写入长期保存的冷数据、备份仓库（restic、borg 的日常备份以追加写为主）。这类负载最容易发挥 HM-SMR 的优势，但"适合"不等于"全程无感"：备份工具的 prune、compact、重建索引阶段会产生删除和元数据改写，rsync 增量同步会改写既有文件，NVR 类软件可能频繁更新索引数据库——这些维护阶段的延迟和写放大要单独测过才能下结论，只测一轮全量上传是不够的。

**不适合**：当日常 NAS 数据盘（家庭 NAS 的写入远比想象中随机）、BT 下载盘（大量乱序写+预分配）、数据库或虚拟机存储。dm-zoned 能让这些场景运行，但回收压力大时延迟波动会非常明显。

总结：**它的低价来自负载限制。负载匹配时性价比很高，不匹配时不建议购买。**

## 附录 A：Raspberry Pi OS 自编内核路线

如果这台 Pi 还要承担 Pi OS 生态绑定的任务（比如 libcamera/rpicam 摄像头栈），可以走自编内核路线。基于官方 defconfig 补上以下选项：

```
CONFIG_BLK_DEV_ZONED=y    # 必需，块层 zoned 支持，f2fs/btrfs 的 zoned 路径随之启用
CONFIG_DM_ZONED=m         # 按需，方案一 dm-zoned
CONFIG_ZONEFS_FS=m        # 按需，zonefs
```

流程与官方文档的内核编译指南一致：拉取 `raspberrypi/linux` 对应分支 → `make bcm2712_defconfig` → `menuconfig` 中启用上述选项（Enable the block layer → Zoned block device support；Device Drivers → Multiple devices driver support → Device mapper support → Drive-managed zoned block device target support；File systems → zonefs）→ 编译安装。完整的编译与长期维护流程（交叉编译环境、config fragment 脚本化、独立内核名安装布局、一行回滚、跟版节奏）我会另文展开。

问题是**自编内核不在 apt 更新体系内**。但维护可以做得比每次更新被动重编体面。推荐的做法是编译时用 `LOCALVERSION` 起独立版本名（如 `-zoned`），内核镜像安装为独立文件（如 `/boot/firmware/kernel-zoned.img`），`config.txt` 里 `kernel=kernel-zoned.img` 指定加载——官方内核更新只覆盖它自己的 `kernel_2712.img`，与你的内核互不干扰，系统其余部分照常 `apt full-upgrade`。维护由此变成主动决定跟版节奏（比如按月，交叉编译一次约二十分钟机器时间），把 config 改动固化成 fragment 加构建脚本即可。但是两次跟版之间你的内核吃不到安全补丁，适合内网存储机，不适合暴露面大的场景。另外排除一个看似可行的思路：DKMS 式的模块外挂不存在。`CONFIG_BLK_DEV_ZONED` 是编入内核本体的块层核心选项，`dm-zoned`、`zonefs` 模块都依赖它，没有不重编内核的逃生门。

```bash
# 或也可以尝试向上游提交 issue 或 PR，讨论是否适合在 Pi 5 默认配置中启用 zoned 支持，是否接受则取决于维护者对使用范围和内核配置成本的权衡。
```

## 附录 B：根治 Rust coreutils 的 AppArmor 刷屏

26.04 的 coreutils 换成了 Rust 实现（uutils），`who` 等命令启动时会读取本地化文件 `/usr/share/coreutils/locales/`，而配套的 AppArmor profile 没有放行这个路径，SSH 客户端的远程监控栏每秒调用一次 `who`，就每秒产生一条 audit，还顺带让 `who` 没有输出。放行方法是向 profile 的 local 覆盖文件追加一条读取规则（用 local 覆盖而不是直接改 profile 本体，包更新时不会被冲掉）：

```bash
sudo apt update && sudo apt upgrade    # 先看是否已有官方修复
sudo aa-status | grep who              # 实测 profile 名即为 who
# Ubuntu 已为每个 profile 预置 local 覆盖文件，直接追加规则即可
echo "/usr/share/coreutils/locales/** r," | sudo tee -a /etc/apparmor.d/local/who
sudo apparmor_parser -r /etc/apparmor.d/who
who                                    # 应恢复正常输出，audit 不再新增
```

生效后 `who` 恢复正常输出，audit 刷屏停止。
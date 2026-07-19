---
title: PCB设计注意事项——MOSFET的不同封装
date: 2026-04-06 16:50:40
categories: [Hardware]
tags: [PCB Design, MOSFET, Electronics]
description: 记录一次因 MOSFET 封装引脚排列不一致（G-S-D 误用为 D-G-S）导致体二极管正偏短路的排查过程：限流电源如何兜住这类错误、用万用表二极管档反推源漏极，以及避免封装引脚错配的核对习惯。
---

# PCB设计注意事项——MOSFET的不同封装

在最近的PCB设计中，我遇到了一个典型但极易被忽略的硬件错误，特此记录以作备忘。这个项目涉及到一个基础的低侧开关（low-side switch）电路，使用 N 沟道 MOSFET 来驱动一个 LED 负载。

## 1 现象与问题诊断
**不同的 MOSFET 封装有着截然不同的引脚排列。**

我使用的MOSFET型号是2N7002，其引脚示意图如图1所示。

<figure>
    <img src="https://img.gulugulublog.com/posts/pcb-design-consideration-different-mosfet-packages/2N7002PinoutDiagram.png" width="80%">
    <center><figcaption>图1 2N7002引脚示意图</figcaption></center>
</figure>

图2为原理图，MOSFET选择了正确的引脚布局，其中控制信号（Signal_In）连接到引脚1，地（GND）连接到引脚2，负载（LED D1 和限流电阻 R6）连接到引脚3。这对应的是 G-S-D 的引脚顺序：

引脚1：栅极（Gate），接收驱动信号；

引脚2：源极（Source），接地参考；

引脚3：漏极（Drain），接入负载。

<figure>
    <img src="https://img.gulugulublog.com/posts/pcb-design-consideration-different-mosfet-packages/Schematic-with-correct-pin-assignments.png" width="80%">
    <center><figcaption>图2 使用正确引脚布局的原理图</figcaption></center>
</figure>

但第一次绘制原理图时，我错误地套用了一个 D-G-S 排列的封装符号。此时的等效原理图如图3所示。

<figure>
    <img src="https://img.gulugulublog.com/posts/pcb-design-consideration-different-mosfet-packages/Equivalent-schematic-for-incorrect-pin-assignment.png" width="80%">
    <center><figcaption>图3 错误引脚分配的等效原理图</figcaption></center>
</figure>

错位之后，实际落到焊盘上的网络变成了：栅极接到了负载、源极接到了信号、漏极接到了地。N 沟道 MOSFET 的体二极管（body diode）阳极在源极、阴极在漏极，所以当控制信号输出高电平时，源极电位高于漏极，体二极管被正向偏置，电流直接从信号源经体二极管灌到地，造成短路——在这条路径里，MOSFET 从头到尾都没有作为开关工作过。

这里我在测试时用可调电源预先设了限流，没有造成严重后果。值得一提的是，看到限流灯亮起、电流顶到设定上限，就是这条短路在起作用，这是接错位最典型的症状，不必怀疑其他地方。

事后定位电极也有个简单办法：用万用表的二极管档量体二极管，读到约 0.5~0.7 V 正向压降的那一对引脚，阳极即源极、阴极即漏极，据此就能反推物理引脚的归属。

临时的解决方案是把贴片上的MOSFET整体逆时针挪一个引脚位（即把 G-S-D 转成 D-G-S 的朝向）。如图4所示。

<figure>
    <img src="https://img.gulugulublog.com/posts/pcb-design-consideration-different-mosfet-packages/PCB-with-a-temporary-repair.png" width="80%">
    <center><figcaption>图4 临时修复的PCB</figcaption></center>
</figure>

## 2 经验总结

在实际的硬件工程中，对于常见的晶体管封装，业界并没有绝对统一的引脚标准。即使是外观完全相同的SOT-23封装，不同型号或不同制造商的MOSFET，其1、2、3号引脚对应的G、D、S极也可能大相径庭。

为避免未来在焊接时出现需要割线飞线，甚至重新打板的低级错误，我对自己做如下要求：

- 永远不要凭借经验假设引脚排列。在分配封装前，必须打开该具体型号元件的数据手册，严格核对物理引脚序号与内部逻辑电极的对应关系。

- 在原理图设计中，尽量使用带有明确引脚顺序后缀的符号，并确保它与物理封装的焊盘标号一一对应，或者按照元件建立对应的符号和封装。

- 布局完成后，除了常规的电气规则检查，对照各个核心部件的数据手册进行二次检查。

- 条件允许时，贴板上电先用限流电源点测，把电流上限设在安全范围内，靠它兜住接错位这类低级错误。

**最后祝各位设计顺利。**

---
title: 坎特伯雷大学机械工程硕士课程介绍——基于本人所选课程（Semester 1）
date: 2026-06-15 20:07:38
categories: [Study Notes]
tags: [University of Canterbury, Mechanical Engineering, Postgraduate]
description: 基于本人 26S1 实际修读经历，介绍坎特伯雷大学机械工程硕士第一学期四门课程（ENME603 线性控制、ENME623 仪器与传感器、ENMT665 嵌入式软件、ENMT672 嵌入式电子与电源）的授课内容、考核方式与选课建议。
---

{% note info %}
本文中的课程评价均为本人在Semester 1修读期间的个人体会,带有主观性,不代表课程的客观水平。坎特伯雷大学的授课内容、考核方式与任课教授每年都可能调整,本文所述未必与你将来实际遇到的情况一致。以下内容仅供选课参考,具体请以学校官方课程大纲及最新通知为准。
{% endnote %}

# 坎特伯雷大学机械工程硕士课程介绍——基于本人所选课程（Semester 1）

---

## ENME603-26S1 — Advanced Linear Systems Control and System Identification

**课程内容**

本课程包含两条主线：**线性系统控制（Linear Systems Control）** 为讲授与考试的主体，**系统辨识（System Identification）** 则以课后 Quiz 的形式单独考核，Test 与 Exam 不涉及。

在 26S1，本课程尝试将全部学习内容录制为视频并上传至 Learn 平台，线下课堂则用于讲解学生提出的疑问、共性问题以及作业。教授最后对学生进行了相关调研，但此后的授课形式尚不确定。

线性控制部分以状态空间（State Space）方法为主线，依两次 Test 分为前后两个阶段。

第一阶段（Lecture 1–11，对应 Test 1 范围）以基础内容为主：

- State Space Equations 状态空间方程的建立与表示
- Non-uniqueness of States & Modal Transform 状态的非唯一性与模态变换
- Transfer Function ↔ State Space 传递函数与状态空间互转（含可控标准型 CCF）
- Discrete Time Systems 离散时间系统
- Controllability & Observability 可控性与可观性（特征向量法、矩阵法、可镇定性 Stabilizability）
- State Transition Matrix / e^At 状态转移矩阵与求解
- （Linearisation 系统线性化仅在讲义中给出，不单独讲授）

第二阶段（Lecture 12–21，对应 Test 2 范围）侧重设计：

- Pole Placement 极点配置（理论与跟踪增益 Tracking Gains）
- Estimator Design & Separation Principle 估计器/观测器设计与分离原理
- Lyapunov Stability 李雅普诺夫稳定性
- Optimal Control 最优控制：H-infinity、LQR
- （LQG 最优估计器设计与整体复习同样仅在讲义中给出）

线性控制部分配有 7 次作业（Homework 1–7），与各主题一一对应，仅作为课后练习，不计分，但值得一做。

系统辨识部分由 4 个 **Parameter Identification Quizzes 参数辨识课后 Quiz** 覆盖，**不纳入考试范围**：

- Linear Least Squares 线性最小二乘
- Integral-Based Methods 基于积分的方法
- Steepest Descent 最速下降法
- Gauss-Newton 高斯-牛顿法

**考核方式**

| 项目 | 占比 |
| --- | --- |
| 系统辨识 Quiz | 15% |
| 线性控制 Quiz | 5% |
| Test 1 | 25% |
| Test 2 | 25% |
| Exam | 20% |
| Lab | 10% |

需特别留意的一项规则：若两次 Test 的平均分高于 **75%**，可选择不参加 Exam，最终成绩以两次 Test 的平均分计算。也就是说，前期 Test 表现良好者可免修期末考试。

关于占 10% 的 **Lab**：需为**倒立摆**与**弹簧阻尼串联的三车系统**设计控制器，涉及**极点配置**与 **LQR**；先完成参数计算，再到实验室输入并运行。实测存在失败的可能，但不必过度担心——并非所有人都能成功运行，关键在于认真完成实验报告。此外，提交实验报告前另有一个设计封面的小环节（是否每年设置尚不确定）；若不愿在此投入精力，用 AI 生成一张图作为封面提交即可。

**注意事项 & 建议**

所需基础：

- **线性代数**：至少应掌握矩阵运算、特征值与特征向量的求解、行列式（det）的计算
- **工程控制原理**：至少应了解极点位于不同位置时的系统表现，以及传递函数的基本知识

几点建议：

- 课程开篇会涉及较多数学推导，但不必因此感到畏惧，**整体难度并不高**。
- 两次 Test 中可能有一次在**难度与计算量上明显加大**，建议提前做好准备。
- 考试时应保持信心，**优先完成所有题目**；反复翻看、纠结于个别题目容易导致时间不足。
- Test 允许携带**单面 A4 纸**，Exam 允许携带**正反双面 A4 纸**，建议提前整理好笔记。

---

## ENME623-26S1 — Advanced Instrumentation and Sensors

**课程内容**

本课程围绕传感、仪器与测量展开，分为 Term 1 与 Term 2 两个学期，讲授配合贯穿全程的 LabVIEW 实验与设计项目。

Term 1 讲授（Module I–IV），偏信号与测量基础：

- I. Measurement Specifications 测量系统规格：测量系统指标、Noise 噪声
- II. Signal Conditioning & Processing 信号调理与处理：A/D 转换、Interference 干扰、模拟/数字滤波器、FIR/IIR 滤波器设计、Fourier Transform 傅里叶变换、高通/带通/带阻滤波器
- III. Sensor Fusion 传感器融合
- IV. Measurement Examples 测量实例

Term 2 讲授（Module V–VII），偏统计与实验设计：

- V. Measurement Theory & Statistical Analysis 测量理论与统计分析：直方图/频率/PDF、高斯分布与正态误差函数、Student's t 分布、假设检验（z 检验、t 检验）、合并统计、卡方分布与拟合优度、离群值识别、测量次数
- VI. Regression & Measurement Uncertainty 回归与测量不确定度：回归分析（多项式拟合与拟合误差）、测量不确定度分析
- VII. Design of Experiments 实验设计：DOE、析因与分式析因设计、方差分析（ANOVA）入门

Term 1 配有每周 LabVIEW 实验（Lab，全程使用 LabVIEW）：

- Lab 0 — Introduction to LabVIEW：LabVIEW 入门
- Lab 1 — Bio-instrumentation：搭建程序测量血压与心率
- Lab 2 — LED Control：控制多色 LED 灯带
- Lab 3 — Micro-Mill：控制微型铣床
- Lab 4 — Parallel Robot：按坐标控制并联机器人移动
- （Lab 2、3、4 在 Week 3–5 轮换进行）

Lab 1—5 各需要完成一份课后练习题。

Term 2 有两个 Project：

- **Instrumentation Design Project 仪器设计项目**（小组，3–4 人）：为悬臂梁（cantilever beam）设计并搭建测量系统，在静态、振动、以及振动台（shake table）外部扰动三种条件下测量已知重量和未知重量；用 LabVIEW 搭建含 GUI 的集成系统，最终进行精度评比。
- **Research Project 研究论文**（仅 ENME623 需要，ENME423 不需要）：自选一个与传感和仪器相关的系统（地面车辆、水下机器人、无人机、农业机器人、辅助机器人等），完成文献综述与批判性综述，按 IEEE 格式撰写 2,000–2,500 字的学术论文（含标题页、摘要 ≤250 词及至多 5 个关键词、正文）。

**考核方式**

| 项目 | 占比 |
| --- | --- |
| Labs（Term 1 每周评估） | 10% |
| Term 1 Test | 15% |
| Research Assignment | 20% |
| Instrumentation Design Project | 20% |
| Final Exam | 35% |

监考部分（Test 与 Exam 的加权平均）须达到 **33%** 的最低及格线。需注意：以上为 ENME623 的占比；ENME423 不撰写研究论文，整体占比会相应调整，具体以官方 Course Outline 为准。

**注意事项 & 建议**

关于 LabVIEW 与实验：

- 实验全程使用 **LabVIEW**，形式为小组合作，但 Term 1 的实验理论上完全可以单人完成，也可以提前自行做完。
- 可自行到官网下载最新版本练习，但需注意实验室机器用的是 **2025 版**（唯独 LED 实验是 2015 版），交付前记得将文件转换为对应版本。
- 若希望 Term 2 的设计项目做得轻松一些，**强烈建议把 Term 1 的实验认真做、认真学**。

关于设计项目：

- **强烈建议寻找靠谱的队友**，至少不能中途消失；是否与本地学生合作视个人情况而定，此处不作评价。
- 测量结果前三名有额外加分（+3 / +2 / +1）。
- 整个设计项目的不确定性很高，**没有十足把握时不建议投入过多时间，该放手时应及时放手**。

关于考试：

- Test 允许携带 **1 张 A4 纸（正反面）**，Exam 允许携带 **2 张 A4 纸（正反面）**，建议提前整理好笔记。

---

## ENMT665-26S1 — Embedded Systems Software I

> 这是一门新开的课，26S1 为第二次开课，选课人数很少（本次仅 3 名学生）。没有 Lecture，全部学习材料都在 Learn 平台上自学，线下只有 tutorial，主要用于答疑与交流。

**课程内容**

课程没有传统讲授，由一系列在线 Learning Module（LM）构成，分为前后两段。

前 6 周为双轨学习模块，每周各一个：

**C Programming（C LM1–6）**——嵌入式开发的主力语言 C：

- LM1: Getting Started 入门
- LM2: Expressions, Flow Control, Functions and Scope 表达式、流程控制、函数与作用域
- LM3: Memory, Pointers and Arrays 内存、指针与数组
- LM4: Data Structures and Modules 数据结构与模块
- LM5: Strings, IO and other things 字符串、IO 及其他
- LM6: Dynamic Memory 动态内存

**Computer Architecture（Architecture LM1–6）**——计算机内部对 C 代码"物理上"如何响应，主线是从晶体管一路到 CPU、外设与通信：

- LM1: CMOS to Arithmetic 从 CMOS 到运算（布尔逻辑、Math Machines）
- LM2: From Multiplexing to Memory 从多路复用到存储（状态与存储、累加器）
- LM3: ALU to CPU 从 ALU 到 CPU（指令与汇编）
- LM4: （这一周未布置，直接跳过，后续可能LM3的内容会拆分到LM4）
- LM5: ADC and DAC 模数/数模转换（含 PWM 与定时器、GPIO 与内存映射外设、与外设通信）
- LM6: Serial Communication 串行通信

后 6 周为嵌入式系统模块（LM7–12），将 C 与架构知识融合：

- LM7: Thinking Like an Embedded Programmer 像嵌入式程序员一样思考（寄存器与 volatile、驱动）
- LM8: Program Structure and Scheduling 程序结构与调度（状态机、中断及其风险、调度器与 RTOS）
- LM9: Streams and Buffering 流与缓冲（缓冲问题、双缓冲）
- LM10: Writing Better Code 写出更好的代码（git 版本控制、模块化、MISRA）
- LM11: User Interfaces 用户界面
- LM12: MCU Shopping 选购微控制器

**Assignment（占 40%，重头戏）**：把一个来自高层参考（Python、MATLAB、伪代码或论文）的算法，移植为运行在 **STM32C071 Nucleo（配 RCAP 子板）** 上的小型 C 库，要驱动一个真实输出、处理一个真实输入，或两者皆有。RCAP 子板上配有 6 轴 IMU、OLED 屏幕、摇杆、四个按钮、LED、蜂鸣器与振动电机，可供调用。可自带题目（个人项目、朋友的项目、其他课程中需要嵌入式代码的部分），否则有一份示例清单可选。提交物包括：C 库、研究/设计报告、自评（self-review）、git 历史；并在学年最后一节 tutorial 现场演示运行。

**考核方式**

| 项目 | 占比 |
| --- | --- |
| C Learning Modules | 20% |
| Architecture Learning Modules | 15% |
| Assignment | 40% |
| Exam | 25% |

关于 Learning Module 有一点要特别注意：**C 模块以首次作答的成绩计分**（为避免靠猜），完成后才开放重做用于练习——因此作答前务必看完材料、想清楚再提交。

Exam（25%）整张卷子围绕一个贯穿场景：依据一组需求设计一个基于微控制器的控制系统。开卷还是闭卷并不固定——本次由教授直接让学生选择。

**注意事项 & 建议**

关于课程形式：

- 全程自学，没有 Lecture，线下 tutorial 仅作答疑——**自律和时间规划很重要**。
- C 模块首次作答即计分，提交前一定要把材料吃透。

选课与学习建议：

- **推荐与 ENMT672 一起选**，两门课是同一位教授。
- **Term 1 阅读量较大**，核心是"从晶体管到 CPU"这条线（阅读材料中包含用仿真软件搭建简易 CPU 的演示），建议提前安排好时间。

---

## ENMT672-26S1 — Electronics and Power for Embedded Systems

> 本课程与 ENMT665 由同一位教授负责，授课形式与情况也相近：26S1第二次开课，没有传统的现场讲授，学习通过 Learn 上按周发布的在线模块完成，线下 tutorial 主要用于答疑与交流。

**课程内容**

课程以 11 个按周发布的 Learning Module（LM1–11）为主线，从电子学基础一路走到电源、电机驱动、热设计与电路仿真：

- LM1: Electronics Refresher 电子学复习——电路基本定律、无源元件（R/L/C）、二极管/MOSFET/运放等（视作先修内容的复习）
- LM2: Real Components 真实元件——实际元件与信号同理想模型的差异、元件选型与采购、看懂 datasheet
- LM3.1: PCB Design 印刷电路板设计——PCB 制造工艺、信号回路、热设计、叠层等
- LM3.2: KiCad Tutorial KiCad 教程——用开源 EDA 工具画原理图与 PCB
- LM4: Switch-mode Power Supplies (Theory) 开关电源（理论）——DC-DC 转换、Buck/Boost、占空比与纹波
- LM5: SMPS Practicalities 开关电源实务——元件选型与 PCB 布局
- LM6: Driving Large Loads 驱动大负载——用 BJT/MOSFET 控制大电流、DC/无刷/步进电机、H 桥与电机驱动 IC
- LM7: Analog Electronics 模拟电子——模拟信号链、放大与滤波、噪声、线性稳压器
- LM8: Energy Budgets 能量预算——功耗估算、转换效率、低功耗模式
- LM9: Batteries and Power Supplies 电池与供电——电池类型与充电、容量、AC-DC/DC-AC 转换
- LM10: Beating the Heat 散热——发热机理、温度对元件的影响、热管理
- LM11: Nonlinear Simulation 非线性仿真——SPICE/LTSPICE，超越 Falstad 的更精确仿真

实践部分是两个 PCB 设计大作业（占比见下）：Assignment One 设计一块用于供电与电机驱动的 PCB；Assignment Two 在其基础上针对自选的严苛环境做改版，并包含研究报告与同行评审（peer review）。

**考核方式**

| 项目 | 占比 |
| --- | --- |
| Learning Modules | 15% |
| Assignment One | 20% |
| Assignment Two | 30% |
| Exam | 35% |

**注意事项 & 建议**

所需基础：

- 课程把基础电子学（约 ENME313 水平：电路分析基本定律、R/L/C 无源元件，以及二极管、MOSFET、运放的理想特性）视作先修内容，并专门用 LM1 做了复习。所以即便这部分有些生疏，也能靠这个模块补回来——是否一定要提前掌握，因人而异。

几点建议：

- 与 ENMT665 是同一位教授，**推荐两门一起选**，知识上有不少呼应；不过**这两门课的知识密度都比较大**，搭配时要安排好精力。
- 课程会用到 **KiCad**画 PCB，可以提前熟悉工具。
- PCB **打样由教授统一送去制作**，自己不用操心打样流程；做好的板子会在 **SMT 实验室**完成贴片与熔炉（回流焊）焊接。

---

## 一些通用建议

- **注意搭配与精力分配**：ENMT665 与 ENMT672 知识密度都偏大；ENME603 数学较多；ENME623 的实验与两个 Project 很占时间。尽量把"重"的部分错开，别让几门的硬骨头堆在同一段时间。
- **跟上自学型课程的节奏**：ENMT665 和 ENMT672 没有现场讲授，全靠按周发布的在线模块，自律和提前规划很关键；卡住了别攒着，多去 tutorial 问。
- **善用 AI，但守住学术诚信**：部分评估明确允许使用生成式 AI（需附使用声明），务必如实标注、避免抄袭，论文类作业尤其要注意。

## 结语

选课没有标准答案，按自己的兴趣和研究方向来就好。这几门课各有侧重——控制、测量、嵌入式软件、电子与电源——希望这份记录能帮你少走点弯路。如有出入或补充，欢迎在评论区指正。

**最后祝各位学业顺利。**

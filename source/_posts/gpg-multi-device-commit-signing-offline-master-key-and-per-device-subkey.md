---
title: GPG 多设备提交签名——离线主 key + 每台设备独立 subkey
date: 2026-06-21 20:11:00
categories: [Linux Security]
tags: [GPG, YubiKey, Git, SSH]
description: 五个工作环境（Windows、WSL、Arch Linux）共用一个 GPG 身份的完整配置：离线 Certify-only 主 key + 每台设备独立 subkey，让每个 commit 显示 Verified，并把设备丢失的影响收敛到吊销单把 subkey。
---

# GPG 多设备提交签名——离线主 key + 每台设备独立 subkey

我有五个工作环境——两台 Windows、各自的 WSL、外加一台 ArchLinux 笔记本——都要往同一个仓库推代码。需求是：让 GitHub 上每个 commit 都显示 Verified，同时多台机器之间的密钥要好管理、好吊销。如果图省事把同一把私钥拷到每台机器，丢一台就等于整个身份泄露，得吊销后所有机器重新配置一遍——这正是要避免的。

这篇是整个配置过程的完整记录，供以后加设备、续期、处理设备丢失时翻阅，也供想搭同样结构的人参考。文中的密钥指纹（fingerprint）、key ID、keygrip 都不是机密，可以照抄；唯一的机密是主 key 的密码，只存在密码管理器里，不写进任何文件。

## 1 为什么是这套结构

后面所有操作都是从三个设计选择推出来的，先把它们讲清楚，比直接抄命令重要得多。

**为什么用 GPG，而不是 SSH 签名。** Git 现在也支持用 SSH key 签 commit，配置更省事。但我选 GPG 图的是一个长期独立性（long-term independence）：GPG 签名只靠公钥本身就能验证，不绑定任何平台。今天在 GitHub 看 Verified，明天迁到自建 Gitea、或者要签 release tag、签固件 `.bin` 发给别人核对，同一套密钥全都通用。身份这件事上的整套生态——keyserver、指纹分发、吊销机制——GPG 成熟得多，值得为它多花这一次配置成本。

**为什么主 key 离线、每台设备只给一把 subkey。** 主 key 是长期身份，要拿去印名片、发 keyserver、写进 release 让别人核对指纹，所以它越稳越好、越少上机越好。日常签 commit 这种高频动作，交给子密钥（subkey）：每台设备一把专属的，互不相同。这样威胁面被切成了小块——丢一台、或某把 subkey 泄露，只要吊销那一把，其他设备和身份本身毫发无伤。主 key 平时就躺在离线 U 盘里，根本不上机。

**为什么主 key 只留 Certify 能力。** 我给主 key 只保留了 Certify（`[C]`）能力，连签名都不让它干。这不是洁癖：把日常签名能力从主 key 上彻底拿掉，等于逼自己只能走 subkey 工作流，堵死了「图省事直接拿主 key 签一下」这个会慢慢侵蚀整套设计的口子。

## 2 密钥与设备全景

> 下文出现的所有指纹、key ID、keygrip、邮箱都是 **示例值**——命令的形状照搬即可，但这些标识符每个人都不同，实际操作时一律替换成你自己的。

一把主 key、三把 subkey，覆盖五个环境。

主 key（Certify only `[C]`，永不过期）：

- 指纹：`1111 2222 3333 4444 5555 6666 7777 8888 9999 AAAA`
- Key ID：`777788889999AAAA`，下文一律简写为 `11112222...`
- Keygrip：`0000111122223333444455556666777788889999`（删主 key 私钥时按它定位文件，记一下）
- 邮箱：`<你的 GitHub noreply 邮箱>`
- 创建：2026-05-12

三把 subkey 均为 RSA4096、仅签名（`[S]`）、两年有效期。选 RSA4096 而非 ed25519，是图各处验证端都认、兼容性最稳妥：

| # | Key ID | 设备 | 创建 | 到期 |
|---|--------|------|------|------|
| 1 | `AAAA1111AAAA1111` | 电脑 1（Windows）+ 其 WSL | 2026-05-12 | 2028-05-11 |
| 2 | `BBBB2222BBBB2222` | 电脑 2（Windows）+ 其 WSL | 2026-05-13 | 2028-05-12 |
| 3 | `CCCC3333CCCC3333` | ArchLinux 笔记本 | 2026-06-21 | 2028-06-20 |

这里有个值得说明的取舍：**WSL 不单独签发 subkey，直接复用宿主 Windows 那台的**。理由是同一台物理机的威胁模型本就相同，给 WSL 再单发一把不带来任何安全收益，只是徒增管理负担。所以表里五个环境只对应三把 subkey。

## 3 U 盘怎么放

主 key 私钥和吊销证书（revocation certificate）是这套方案的两件核心资产，前者是身份本体，后者是身份出事时的救命兜底——它们都放离线 U 盘。我的结构是：

```
E:\IMPORTANT\GPG\
├── GPG.txt                          ← 清单笔记（对应上面「密钥与设备全景」）
├── master-private-11112222.asc      ← 主 key 私钥（永不变，核心资产）
├── revoke-11112222...asc            ← 吊销证书（永不变，救命兜底）
├── v2\
│   ├── subkeys-bundle-v2.asc        ← subkey #1+#2
│   └── public-11112222-v2.asc
└── v3\
    ├── subkeys-bundle-v3.asc        ← subkey #1+#2+#3
    └── public-11112222-v3.asc       ← 当前 GitHub 上的公钥版本
```

原则就一句：**永不变的放根目录，随 subkey 增减的按版本进 `vN\`**。每加一台设备，subkey 多一把，bundle 和公钥就升一版，主 key 与吊销证书纹丝不动。

几条实践教训，都是「不这么做将来会后悔」那种：

- 至少两个 U 盘做镜像、分开存放，防丢、防坏、防同地遭灾。
- 吊销证书是纯 ASCII，**打印一份纸质版锁起来**当终极兜底——下面「出事了怎么办」会讲到它为什么值得这么郑重对待。
- 主 key 密码存进密码管理器，绝不写进任何文件。说第三遍了，因为忘了它就真没救。

## 4 从第一台电脑搭起

第一台机器要把整套密钥从无到有建起来，后面加设备就轻量得多。以下命令是 Windows（PowerShell）版。

**1. 生成主 key（只留 Certify）。**

```powershell
gpg --full-generate-key --expert
# kind:    8（RSA，自定义能力）
# 能力界面：按 S 关掉 Sign、按 E 关掉 Encrypt，只留 Certify，Q 确认
# keysize: 4096
# valid:   0（永不过期）
# name:    yourname
# email:   <你的 GitHub noreply 邮箱>
# 设一个强密码
```

**2. 给主 key 添加一把签名 subkey。**

```powershell
gpg --expert --edit-key 111122223333444455556666777788889999AAAA
gpg> addkey
# kind: 4（RSA sign only），keysize: 4096，valid: 2y
gpg> save
```

**3. 立刻生成吊销证书**，别拖到「以后再说」——主 key 一旦不可用，这是唯一能对外宣告作废的东西。

```powershell
gpg --output C:\Users\<你>\revoke-11112222...asc --gen-revoke 11112222...
# reason: 1（compromised），最通用的选择
```

**4. 导出三份备份。** 这里有个会直接毁掉备份的坑，先说清楚：**一律用 `gpg --output`，别用 `>` 重定向**。PowerShell 5.1 的 `>` 默认按 UTF-16 写文件，GPG 读不了，将来导入时会报 `gpg: read_block: read error: Invalid packet` 或 `Invalid keyring`，而那时你多半已经把临时文件删了。养成 `--output` 的习惯，这类损坏根本不会发生。

```powershell
gpg --output $HOME\master-private-11112222.asc  --armor --export-secret-keys     11112222...
gpg --output $HOME\subkeys-bundle.asc           --armor --export-secret-subkeys  11112222...
gpg --output $HOME\public-11112222.asc          --armor --export                 11112222...
```

（万一已经用 `>` 写坏了某个 `.asc`，可以这样抢救一次：`Get-Content 坏文件 -Encoding Unicode | Set-Content 新文件 -Encoding ascii`。但根治办法还是改用 `--output`。）

**5. 核心一步：把主 key 私钥从本机删掉，只留 subkey。** 这步做完，这台机器才真正符合「日常机不持有主 key」的设计——之前所有铺垫都是为了能安全地走到这里。

```powershell
# 先确认主 key 的 keygrip（sec 行下方那个）
gpg --list-secret-keys --with-keygrip 11112222...
# 按 keygrip 删掉主 key 私钥文件
Remove-Item $env:APPDATA\gnupg\private-keys-v1.d\0000111122223333444455556666777788889999.key
```

验证：再 `gpg --list-secret-keys 11112222...`，`sec` 应变成带井号的 `sec#`（表示私钥不在本机），而 `ssb` 不带井号（subkey 仍可签名）。**`sec#` + 无井号 `ssb` 就是这台日常机该有的正确状态**，后面每台都以它为准。

**6. 配置 git。** signingkey 末尾那个感叹号是关键，它强制 git 用这一把指定的 subkey，而不是让 GPG 自己挑。

```powershell
git config --global gpg.program "C:/Program Files/GnuPG/bin/gpg.exe"   # 路径用正斜杠，有空格加引号
git config --global user.signingkey AAAA1111AAAA1111!                  # 注意末尾感叹号
git config --global commit.gpgsign true
git config --global tag.gpgsign true
git config --global user.email "<你的 GitHub noreply 邮箱>"
git config --global user.name "yourname"
```

**7. 上传公钥到 GitHub。** `gpg --armor --export 11112222... | Set-Clipboard`，然后到 Settings → SSH and GPG keys → New GPG key 粘贴。

**8. 测试，并确认它真的生效了。**

```powershell
git log --show-signature -1   # 看到 Good signature
git push                      # GitHub 网页上该 commit 显示 Verified 绿标
```


## 5 加一台新设备

这是日后最常走的流程，分三段：在已有设备上签发新 subkey、更新 GitHub 公钥、新机导入。

**阶段 A——签发新 subkey（需要插 U 盘导入主 key）。**

```powershell
# 1. 导入主 key（导入后 sec 应无井号，因为这次要用它签发）
gpg --import E:\IMPORTANT\GPG\master-private-11112222.asc

# 2. 关键：先把上一版公钥导进来，补全已有的所有 subkey 公钥
gpg --import E:\IMPORTANT\GPG\v2\public-11112222-v2.asc
gpg --list-keys 11112222...    # 确认旧的 subkey 公钥都在

# 3. 加新 subkey
gpg --expert --edit-key 11112222...
gpg> addkey      # 4 / 4096 / 2y
gpg> save

# 4. 导出新版 bundle + 公钥
gpg --output $HOME\subkeys-bundle-vN.asc  --armor --export-secret-subkeys 11112222...
gpg --output $HOME\public-11112222-vN.asc --armor --export                11112222...

# 5. 删主 key 私钥，回到 sec# 状态
Remove-Item $env:APPDATA\gnupg\private-keys-v1.d\0000111122223333444455556666777788889999.key

# 6. 新文件存进 U 盘的 vN\，删掉本机临时文件
```

阶段 A 第 2 步那行不起眼，但漏了它会埋一个很隐蔽的雷，我踩过：导出主 key 私钥备份的那一刻，它**只包含当时存在的 subkey**。如果你直接拿这份旧备份来签发、导出新公钥，新公钥里就会缺掉后来加的 subkey，结果是**其他设备的 commit 集体变成 Unverified**——而它们什么都没改，纯粹是被你这次操作连累的。所以导出新公钥**之前**，务必先 import 上一版 `public-vN.asc` 把所有 subkey 公钥补齐。

**阶段 B——更新 GitHub 公钥。** 删掉旧的那把 GPG key，上传新的 `public-11112222-vN.asc`，然后在页面上确认它列出了**全部** subkey。历史上那些已经 Verified 的 commit 不受影响，GitHub 会拿新公钥自动重新验证。

**阶段 C——新设备导入配置（以 Linux 为例）。**

```bash
gpg --import public-11112222-vN.asc
gpg --import subkeys-bundle-vN.asc

# 删掉不属于本机的 subkey 私钥，只留本机专属那把的 keygrip
rm ~/.gnupg/private-keys-v1.d/<其他设备 subkey 的 keygrip>.key

# 配 git，signingkey 用本机专属 subkey
git config --global user.signingkey <本机 keyid>!
# ……其余 gpgsign / email / name 同第一台

# 用完即焚，安全删除导入文件
shred -u subkeys-bundle-vN.asc
```

导入后如果 `gpg --list-keys` 里 uid 显示成 `[unknown]`，别慌——那是新机器的 trustdb 还没把这把 key 标记为「自己的」，纯本地显示问题，不影响签名功能。`gpg --edit-key 11112222... → trust → 5（ultimate）→ quit` 改回来即可。

## 6 各环境的差异

绝大多数步骤是通用的，这里只记三类环境各自要拐的弯。

**Windows（电脑 1 / 电脑 2）。** 两台 gpg.exe 装在不同盘，`gpg.program` 各指各的（电脑 1 是 `C:/Program Files/GnuPG/bin/gpg.exe`，电脑 2 在 `D:/...`），路径统一用正斜杠、带空格加引号。signingkey 各用各的 subkey（电脑 1 是 `AAAA1111AAAA1111`，电脑 2 是 `BBBB2222BBBB2222`）。

**WSL（复用宿主 subkey）。** 前面说过 WSL 不单发 subkey。从宿主 Windows 导出本机那把就行，末尾感叹号表示只导这一把：`gpg --output ... --export-secret-subkeys <宿主 keyid>!`。WSL 里导入公钥 + 这把 subkey，配好 git，`gpg.program` 直接用 `$(which gpg)`。

**ArchLinux 笔记本（独立物理机）。** 这台签发了专属的 subkey #3。导入后记得删掉不属于它的 subkey 私钥（按 keygrip：`rm ~/.gnupg/private-keys-v1.d/<其他设备 subkey 的 keygrip>.key`），只留自己那把 `<本机 subkey 的 keygrip>.key`。`gpg.program` 用 `$(which gpg)`，图形环境下可装 pinentry-gtk/qt 走弹窗输密码。

> Linux 侧（WSL 和 ArchLinux 都算）第一次 commit 常会撞上 `Inappropriate ioctl for device`，那是 pinentry 找不到当前 TTY。一行配置解决，写进 shell 的 rc 里一劳永逸：
>
> ```bash
> echo 'export GPG_TTY=$(tty)' >> ~/.bashrc
> source ~/.bashrc
> ```

## 7 日常维护与续期

**日常签名是全自动的**，只在 gpg-agent 缓存过期、需要重新解锁时弹一次 pinentry 输密码，平时无感。

**subkey 每两年到期，要续。** 首次提醒我设在了 2028-04（赶在第一批 5 月到期前）。续期同样要插 U 盘请出主 key：

```powershell
gpg --import master-private-11112222.asc
gpg --edit-key 11112222...
gpg> key 1          # 选中要续的 subkey
gpg> expire         # 设新到期日
gpg> save
# 之后照例：导出新公钥上传 GitHub、导出新 bundle 备份、删主 key 私钥
```

这套结构搭好之后，还能按需解锁一些进阶玩法，列在这儿当备忘，不是必需：

- 签 release tag：`git tag -s v1.0.0 -m "..."`。
- 签固件：`gpg --detach-sign firmware.bin`，把 `.sig` 一起发布供用户验证。
- 把公钥写进 README、推到 keyserver，教用户核对指纹。
- 上 YubiKey：把 subkey 搬进硬件，私钥永不离开硬件。
- 用 `pass`：一个拿 GPG 加密的密码管理器。

## 8 出事了怎么办

这一节但愿用不上，但正是「用不上的时候也得准备好」的东西，才决定了前面那些备份要不要做到位。

**某台设备丢了，或某把 subkey 泄露了。** 不慌，这正是「每机一把 subkey」要解决的场景。插 U 盘导入主 key，`gpg --edit-key 11112222... → key N`（选中那把）`→ revkey → save`，再把更新后的公钥上传 GitHub。被吊销 subkey 签过的历史 commit 仍然 Verified——吊销是带时间戳的，只对吊销之后生效。

**忘了主 key 密码。** 这个救不回来。只能导入吊销证书声明整个身份作废，重新生成一套新的。所以——密码必须存好，这是第四遍了。

**主 key 和 U 盘全丢了。** 拿出那份单独保存（最好还有纸质版）的吊销证书，`gpg --import` 它，再 `gpg --keyserver keys.openpgp.org --send-keys 11112222...` 对外公告作废，然后重走整套流程建新身份。**这就是吊销证书要和主 key 分开存、还要打印一份的全部意义**：它得在主 key 本身已经够不着的时候，依然够得着。

**连吊销证书（含纸质版）也一起灭失。** 这是最坏的情形，但要先分清是「丢了」还是「被偷了」，两者处理完全不同。

如果只是丢失、没落到别人手里：你已经无法吊销了——吊销要么靠主 key、要么靠吊销证书，两样都没了，那份「作废声明」就发不出去。但不必太慌，别人同样拿不到这把钥匙，不存在被冒用的风险。直接放弃这个身份即可：重新生成一套新主 key 与 subkey，更新 GitHub，并在博客 / README 里说明旧 key 已弃用。旧 key 因为设了永不过期，会一直挂在 keyserver 上「看着有效」，这是永不过期的一个代价；介意的话，可以给主 key 设个到期日，让弃用的身份将来自行失效。

如果是被偷、且对方连密码也拿到了：这才是真正棘手的——对方能冒充你签 commit、签 release，甚至签发新 subkey 或反过来吊销你真正的 key。而你既无主 key 也无吊销证书，连「止损式」的吊销都发不出。此时唯一能用的，是 GPG 之外、对方控制不了的可信渠道：用你的 GitHub 账号（它有独立的密码 + 2FA，是另一套信任锚）把那把 GPG key 删掉、不让新 commit 再顶着 Verified，并在博客（走 HTTPS）、README、必要时邮件通知协作者，公告「X 日起此 key 已泄露，请勿再信任」，再用新身份重建信任。损害窗口到大家看到公告为止——影响在声誉与供应链信任层面，能恢复，不是灾难。

退一步看本质：GPG 并没有一个中心化的「删除此密钥」按钮，吊销不过是一份你签出来、再公布出去的声明，只有当你还拿得出主 key 或吊销证书时才发得出。所以在「全部同时灭失」这种极端场景里，真正的兜底不是更多的密码学，而是你那几条彼此独立的身份渠道——GitHub 账号、HTTPS 博客、验证过的邮箱——它们让你能可信地宣布「旧的废了，这是新的」。这也正是前面反复强调备份要多份、异地分开存的原因：把「全部同时灭失」的概率压到足够低，本身就是对这个问题最有效的回答。

## 结语

整套方案听起来环节不少，但真正高频的只有「日常签名」那一项，而它是全自动的；其余步骤——加设备、续期、应急——都是低频操作，照着上面对应小节走即可。把复杂度压在这些少数时刻、换日常的省心和一台设备出事时的从容，我觉得这笔买卖很划算。

最后重申一遍这套记录的安全边界：文中所有 fingerprint、key ID、keygrip 都可以安全公开，唯一的机密是主 key 密码，它只该躺在密码管理器里。但愿那一节「出事了怎么办」你永远用不上。

**最后祝各位配置顺利**

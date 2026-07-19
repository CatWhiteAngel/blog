# 还魂灵猫的博客 | CatWhiteAngel's Blog

[中文](#中文) | [English](#english)

---

## 中文

个人博客源码仓库，站点地址：<https://www.catwhiteangel.com>

### 技术栈

- [Hexo](https://hexo.io/) 8 静态博客框架
- [Butterfly](https://butterfly.js.org/) 主题（npm 安装，配置见根目录 `_config.butterfly.yml`）
- KaTeX 数学公式渲染
- GitHub Actions 自动构建与部署，每周定时死链巡检（`lychee`）

### 本地预览

```bash
npm ci
npx hexo server        # http://localhost:4000
```

要求 Node 版本见 `.nvmrc`。

### 写作与发布流程

```bash
npx hexo new draft "标题"     # 新建草稿（source/_drafts/，不进仓库）
npx hexo server --drafts      # 预览含草稿
npx hexo publish "标题"       # 草稿转正式文章
git add -A && git commit -m "更新文章" && git push
```

push 到 `main` 后由 GitHub Actions 自动构建并发布到服务器，无需本地部署环境。

### 勘误与交流

文章如有错误或过时之处，欢迎提 [Issue](../../issues) 指正，也欢迎在站内评论区留言。

### 授权

本仓库采用双轨授权：

- **文章内容**（`source/_posts/` 及 `source/` 下的其他文字内容）：
  [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/)
  ——署名、非商业性使用、相同方式共享。
- **代码与配置**（构建脚本、workflow、主题配置等其余部分）：
  [MIT](./LICENSE)。

转载文章请注明出处并附原文链接。

---

## English

Source repository of my personal blog: <https://www.catwhiteangel.com>

Posts are written in Chinese.

### Tech Stack

- [Hexo](https://hexo.io/) 8 static site generator
- [Butterfly](https://butterfly.js.org/) theme (installed via npm, configured
  in `_config.butterfly.yml` at the repository root)
- KaTeX for math rendering
- GitHub Actions for automated build & deployment, plus a weekly scheduled
  broken-link check (`lychee`)

### Local Preview

```bash
npm ci
npx hexo server        # http://localhost:4000
```

See `.nvmrc` for the required Node version.

### Writing & Publishing Workflow

```bash
npx hexo new draft "title"    # new draft (source/_drafts/, not committed)
npx hexo server --drafts      # preview including drafts
npx hexo publish "title"      # promote draft to post
git add -A && git commit -m "update posts" && git push
```

Pushing to `main` triggers an automatic build and deployment via GitHub
Actions — no local deployment environment needed.

### Corrections & Feedback

If you spot an error or outdated content, feel free to open an
[Issue](../../issues) or leave a comment on the site.

### License

This repository is dual-licensed:

- **Post content** (`source/_posts/` and other written content under
  `source/`): [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/)
  — Attribution, NonCommercial, ShareAlike.
- **Code and configuration** (build scripts, workflows, theme configuration,
  everything else): [MIT](./LICENSE).

When republishing posts, please credit the source and link to the original.

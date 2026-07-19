---
title: 在Ubuntu24.04上部署LNMP并安装WordPress
date: 2026-03-29 18:28:34
categories: [Web Services]
tags: [WordPress, Nginx, Ubuntu, LNMP]
description: 在 Ubuntu 24.04 上部署 LNMP（Nginx + MySQL 8.0 + PHP 8.3）并安装 WordPress 的完整步骤：php-fpm 套接字配置、mysql_secure_installation 各选项详解、数据库创建，以及上传主题时文件大小限制报错的解决方法。
---

{% note info %}
作者声明：在本文发布时间，本人完整测试了以下所有指令均可正常使用，所有服务能够成功部署。但软件更新迭代速度较快，如软件配置与本文存在差异，以其官方手册为准。
{% endnote %}

# 在Ubuntu24.04上部署LNMP并安装WordPress

LNMP系统架构：

- Linux：操作系统————Ubuntu24.04
- Nginx：Web服务器————Nginx1.24.0
- MySQL：数据库————MySQL8.0.45
- PHP：后端运行环境————PHP8.3

## 1 安装前的准备

使用root用户登录服务器，如果没有root权限，需要在命令前加上sudo

1 更新软件源

```bash
apt update
```

<figure>
    <img src="https://img.gulugulublog.com/posts/deploying-lnmp-and-installing-wordpress-on-ubuntu-2204/1aptupdate.png" width="80%">
</figure>

2 更新软件包并应用安全更新

```bash
apt upgrade
```

<figure>
    <img src="https://img.gulugulublog.com/posts/deploying-lnmp-and-installing-wordpress-on-ubuntu-2204/2aptupgrade.png" width="80%">
</figure>

**注意：**

**时再次执行apt update我们可能发现还有软件包可以升级**

**但是执行apt upgrade或apt dist-upgrade会提示这些软件包会被保持原版本**

**此时我们可以执行apt list --upgradable列出这些软件包并执行apt install 软件包名来将这些软件包强制更新至最新**


## 2 安装PHP

```bash
apt install php-fpm php-mysql php-gd php-curl php-xml php-mbstring php-zip php-intl php-imagick -y
```

<figure>
    <img src="https://img.gulugulublog.com/posts/deploying-lnmp-and-installing-wordpress-on-ubuntu-2204/3installphp.png" width="80%">
</figure>

## 3 安装并配置NGINX

1 安装NGINX

```bash
apt install nginx -y
```

<figure>
    <img src="https://img.gulugulublog.com/posts/deploying-lnmp-and-installing-wordpress-on-ubuntu-2204/4instalnginx.png" width="80%">
</figure>

2 通过浏览器访问服务器外网ip显示nginx界面

注意：阿里云等服务器厂商需要在安全组中放行入方向的80端口

<figure>
    <img src="https://img.gulugulublog.com/posts/deploying-lnmp-and-installing-wordpress-on-ubuntu-2204/5nginxpage.png" width="80%">
</figure>

3 新建站点配置文件

```bash
cp /etc/nginx/sites-available/default /etc/nginx/sites-available/example.com
```

注意：此处example.com可以是准备使用的域名或者网站的名字，任意皆可


4 删除默认配置文件的软链

```bash
rm -rf /etc/nginx/sites-enabled/default
```

5 创建新配置文件的软链使其生效

```bash
ln -s /etc/nginx/sites-available/example.com /etc/nginx/sites-enabled/example.com
```

6 配置example.com配置文件

```bash
vim /etc/nginx/sites-available/example.com
```

按insert键开始编辑，按esc键结束输入，输入:wq并回车保存并退出

修改网站根目录

```conf
root /var/www/html; -> root /var/www/example.com;
```

修改网站名称

```conf
server_name _; -> server_name example.com;
```

使nginx支持php

```conf
index index.html index.htm index.nginx-debian.html; -> index index.php index.html index.htm index.nginx-debian.html;

#location ~ \.php$ {
#          include snippets/fastcgi-php.conf;
#
#          # With php-fpm (or other unix sockets):
#          fastcgi_pass unix:/run/php/php7.4-fpm.sock;
#          # With php-cgi (or other tcp sockets):
#          fastcgi_pass 127.0.0.1:9000;
#}

->

location ~ \.php$ {
          include snippets/fastcgi-php.conf;
#
#          # With php-fpm (or other unix sockets):
           fastcgi_pass unix:/run/php/php8.3-fpm.sock;
#          # With php-cgi (or other tcp sockets):
#          fastcgi_pass 127.0.0.1:9000;
}
```

**注意：此处的fastcgi_pass unix:/run/php/php7.4-fpm.sock;修改成fastcgi_pass unix:/run/php/php8.3-fpm.sock;**

需要与我们安装的php版本相符，通过`ls /run/php`查看

7 刷新nginx配置文件

```bash
nginx -s reload
```

<figure>
    <img src="https://img.gulugulublog.com/posts/deploying-lnmp-and-installing-wordpress-on-ubuntu-2204/6reloadnginx.png" width="80%">
</figure>

8 测试

```bash
mkdir /var/www/example.com
tee /var/www/example.com/index.php <<< '<?php phpinfo();?>'
```

刷新网页出现如下页面说明php生效

<figure>
    <img src="https://img.gulugulublog.com/posts/deploying-lnmp-and-installing-wordpress-on-ubuntu-2204/7phpinfo.png" width="80%">
</figure>


**注意：测试完成必须删除index.php**
```bash
rm /var/www/example.com/index.php
```

## 4 安装并配置mysql

1 安装mysql

```bash
apt install mysql-server -y
```

<figure>
    <img src="https://img.gulugulublog.com/posts/deploying-lnmp-and-installing-wordpress-on-ubuntu-2204/8installmysql.png" width="80%">
</figure>

2 登录mysql
```bash
mysql
```

mysql的root用户默认通过auth_socket登录，此时不需要输入密码或任意密码都可以正常登入mysql数据库，这是因为auth_socket插件利用了Linux的socket机制来验证用户，依赖于当前用户已经获得了足够的权限

```sql
SELECT user, host, plugin FROM mysql.user WHERE user='root';
```

执行以上sql语句验证

<figure>
    <img src="https://img.gulugulublog.com/posts/deploying-lnmp-and-installing-wordpress-on-ubuntu-2204/9authsocket.png" width="80%">
</figure>

如果我们想使用密码登录，可以执行以下sql语句

```sql
ALTER USER 'root'@'localhost' IDENTIFIED WITH caching_sha2_password BY '<your_strong_password>';
```

**注意：请将<your_strong_password>替换为强密码**

输入`exit;`退出

此时可以使用`mysql -uroot -p`命令，输入密码登录

<figure>
    <img src="https://img.gulugulublog.com/posts/deploying-lnmp-and-installing-wordpress-on-ubuntu-2204/10passwordlogin.png" width="80%">
</figure>

3 进行安全性配置

```bash
mysql_secure_installation
```

输入mysql的root用户密码（如果之前设置了密码）

<figure>
    <img src="https://img.gulugulublog.com/posts/deploying-lnmp-and-installing-wordpress-on-ubuntu-2204/10passwordlogin.png" width="80%">
</figure>

是否开启密码检查组件（检查密码的强度）

<figure>
    <img src="https://img.gulugulublog.com/posts/deploying-lnmp-and-installing-wordpress-on-ubuntu-2204/11mysqlsecure.png" width="80%">
</figure>

输入y启用

密码验证策略

<figure>
    <img src="https://img.gulugulublog.com/posts/deploying-lnmp-and-installing-wordpress-on-ubuntu-2204/12passwordvalidation.png" width="80%">
</figure>

输入0代表密码最小长度必须大于等于8个字符

输入1代表密码最小长度必须大于等于8个字符并且是数字，字母，特殊字符混合的

输入2代表密码最小长度必须大于等于8个字符并且是数字，字母，特殊字符混合的，密码不能包含在弱密码字典中

此处我们输入2

是否修改mysql的root用户密码（如果使用auth_socket不会出现此项）

<figure>
    <img src="https://img.gulugulublog.com/posts/deploying-lnmp-and-installing-wordpress-on-ubuntu-2204/13changepassword.png" width="80%">
</figure>

输入n不修改

是否删除匿名用户

<figure>
    <img src="https://img.gulugulublog.com/posts/deploying-lnmp-and-installing-wordpress-on-ubuntu-2204/14anonymous.png" width="80%">
</figure>

输入y删除

是否禁止root用户远程登录

<figure>
    <img src="https://img.gulugulublog.com/posts/deploying-lnmp-and-installing-wordpress-on-ubuntu-2204/15remotelylogin.png" width="80%">
</figure>

输入y禁止

是否删除测试数据库

<figure>
    <img src="https://img.gulugulublog.com/posts/deploying-lnmp-and-installing-wordpress-on-ubuntu-2204/16testdatabase.png" width="80%">
</figure>

输入y删除

最后输入y重新载入配置文件

<figure>
    <img src="https://img.gulugulublog.com/posts/deploying-lnmp-and-installing-wordpress-on-ubuntu-2204/17reloadprivilege.png" width="80%">
</figure>

4、为wordpress新建数据库

登录数据库

创建wordpress数据库

```sql
create database wordpress;
```

新建wordpress用户密码

```sql
create user 'wordpress'@'localhost' identified by '<your_strong_password>';
```

赋予用户对数据库wordpress的全部权限。

```sql
grant all privileges on wordpress.* to 'wordpress'@'localhost';
```

刷新权限使其生效

```sql
flush privileges;
```

退出

```sql
exit;
```

<figure>
    <img src="https://img.gulugulublog.com/posts/deploying-lnmp-and-installing-wordpress-on-ubuntu-2204/18createdatabase.png" width="80%">
</figure>

## 5 安装wordpress

1 下载wordpress文件

```bash
curl -L -A "Mozilla/5.0" -o latest-zh_CN.zip https://cn.wordpress.org/latest-zh_CN.zip
```

<figure>
    <img src="https://img.gulugulublog.com/posts/deploying-lnmp-and-installing-wordpress-on-ubuntu-2204/19downloadwordpress.png" width="80%">
</figure>

2 解压缩

```bash
apt install unzip
unzip latest-zh_CN.zip
```

3 将wordpress文件复制到网站根目录

```bash
cp -a wordpress/. /var/www/example.com/
```

4 更改网站根目录的用户权限

```bash
chown -R www-data:www-data /var/www/example.com
chmod -R 755 /var/www/example.com
```

5 刷新网页进入wordpress安装界面（如果刷新后报错http500可能是php-mysql没有安装）

<figure>
    <img src="https://img.gulugulublog.com/posts/deploying-lnmp-and-installing-wordpress-on-ubuntu-2204/20wordpressinstall.png" width="80%">
</figure>

点击现在开始

填写数据库名，数据库用户名和密码，点击提交

<figure>
    <img src="https://img.gulugulublog.com/posts/deploying-lnmp-and-installing-wordpress-on-ubuntu-2204/21databasesetting.png" width="80%">
</figure>

填写信息并点击安装wordpress

<figure>
    <img src="https://img.gulugulublog.com/posts/deploying-lnmp-and-installing-wordpress-on-ubuntu-2204/22infosetting.png" width="80%">
</figure>

安装成功后即可登录仪表盘对网站进行编辑，输入服务器公网ip可以查看网站主页

<figure>
    <img src="https://img.gulugulublog.com/posts/deploying-lnmp-and-installing-wordpress-on-ubuntu-2204/23instalcomplete.png" width="80%">
</figure>

<figure>
    <img src="https://img.gulugulublog.com/posts/deploying-lnmp-and-installing-wordpress-on-ubuntu-2204/24wordpressfrontpage.png" width="80%">
</figure>

<figure>
    <img src="https://img.gulugulublog.com/posts/deploying-lnmp-and-installing-wordpress-on-ubuntu-2204/25managepage.png" width="80%">
</figure>

## 6 安装后的配置

安装完wordpress后很多人都希望更换一个漂亮的主题，但是在我们上传主题的时候很有可能会出现以下报错，这是因为请求文件太大导致的nginx报错。

<figure>
    <img src="https://img.gulugulublog.com/posts/deploying-lnmp-and-installing-wordpress-on-ubuntu-2204/26filetoolarge.png" width="80%">
</figure>

1 修改nginx配置文件

```bash
vim /etc/nginx/nginx.conf
```

在http中添加一行
```conf
client_max_body_size 16m;
```

```bash
nginx -s reload
```

修改php配置文件

```bash
vim /etc/php/8.3/fpm/php.ini
```

```conf
post_max_size = 8M -> post_max_size = 16M
upload_max_filesize = 2M -> upload_max_filesize = 16M
```

<figure>
    <img src="https://img.gulugulublog.com/posts/deploying-lnmp-and-installing-wordpress-on-ubuntu-2204/27phpconf.png" width="80%">
</figure>

在vim中按下/即可进入查找模式，输入要查找的字符串并按下回车。 vim会跳转到第一个匹配。按下n查找下一个

重启php-fpm

```bash
systemctl restart php8.3-fpm.service
```

再次上传主题文件即可上传成功

<figure>
    <img src="https://img.gulugulublog.com/posts/deploying-lnmp-and-installing-wordpress-on-ubuntu-2204/28themeupload.png" width="80%">
</figure>

## 7 总结

至此，我们完成了：

- LNMP环境搭建
- 数据库配置
- WordPress部署
- 文件上传限制优化

现在我们已经拥有一个完整可用的WordPress站点。
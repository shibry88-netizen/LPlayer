# 签名密钥（folia-release）

Android 正式包签名密钥的**加密备份**。

| 项 | 值 |
| :--- | :--- |
| 密文 | `folia-release.keystore.enc` |
| 明文 | `folia-release.keystore`（**绝不提交**） |
| 算法 | AES-256-CBC + PBKDF2（iter 200000，salt） |
| 密钥别名 | `folia` |
| 有效期 | 30 年 |
| 签名算法 | RSA 4096 |
| 证书 SHA-256 | `c3625223e293f4f221f46d501281589de3f963c31ccb555660f5a114cedeec76` |

**外层口令（openssl）与密钥库口令（keytool）不写在本仓库**，存放在个人文档：
《folia-major · 安卓签名密钥与正式包》。

## 解密与使用

```bash
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 \
  -in keystore/folia-release.keystore.enc \
  -out folia-release.keystore -pass pass:'<外层口令>'

keytool -list -v -keystore folia-release.keystore -storepass '<密钥库口令>' | head -20
```

签名（构建产物已 zipalign）：

```bash
apksigner sign --ks folia-release.keystore \
  --ks-pass pass:'<口令>' --key-pass pass:'<口令>' \
  --v1-signing-enabled true --v2-signing-enabled true --v3-signing-enabled true \
  --out Folia-x.y.z-android.apk app-aligned.apk
```

## 铁律

**这套密钥必须留住、且每次出包后校验指纹**：Android 规定同一 `applicationId`
只有签名相同才能覆盖安装，换密钥 = 用户必须卸载重装（数据、登录态全丢）。
校验方式见 `docs/android-apk-build.md`。

# remote_pi_identity

基于平台原生密钥同步的 Owner 密钥 Ed25519 身份，在同一个人的多台设备之间同步 —— iOS 上用 **iCloud Keychain**，Android 上用 **Block Store**。

Remote Pi monorepo 的内部插件，不发布到 pub.dev。

## 职责范围

这个插件只做一件事：把单个 Owner Ed25519 密钥对（64 字节 —— `ownerPk || ownerSk`）持久化到当前平台同步的密钥存储中，并通过 Stream 把变更暴露回 Dart。

它**不**负责生成密钥对、不做任何加密操作、不访问中继，也不知道什么是已配对 peer。那个 blob 就是不透明字节 —— 编码解码在 [`OwnerIdentity.toBlob` / `fromBlob`](lib/src/owner_identity.dart) 里，格式固定为 64 字节。

### 范围之外

以下职责属于更高层（app + Pi extension + 中继），不属于这个插件：

- **已配对 peer 列表。** 这个人跟哪些 Pi 配对过 —— 包括 `remote_epk`、中继 URL、room id、昵称 —— 存在 app 的本地存储里（如果将来 mesh 状态需要在设备间漫游，或许还会放进另一个同步面）。
- **mesh 版本管理。** 由什么协议判定「这台设备有更新的 peer 列表视图」，是 mesh 层要操心的事，不是这个插件的。
- **撤销传播。** 在这里抹掉 owner 身份，只是抹掉该账号的本地同步面；通知中继下线 presence、通知其他设备忘掉这个密钥、通知已配对的 Pi 撤销 —— 全都在这个插件之外编排。

这个 64 字节 blob 有意不带版本字段 —— 没什么可迁移的。万一将来需要别的 schema，那是新插件（或新的 method channel 面），而不是这里的升级路径。

## 平台要求

| 平台 | 最低版本 | 同步面 | 设备上需要什么 |
|---|---|---|---|
| iOS | **26.0** | iCloud Keychain（`kSecAttrSynchronizable=true`） | 已登录 iCloud + 已开启 iCloud Keychain |
| Android | **API 34**（Android 14） | Block Store（`setShouldBackupToCloud(true)`） | Google 账号 + 已开启 Google Backup + 已设置锁屏 |

iOS 上插件用 generic-password 类型的 Keychain 条目；Android 上用 Google Play Services 的 Block Store（`play-services-auth-blockstore:16.4.0`）。两侧都不碰由硬件背书的密钥 —— blob 是不透明字节，这样才能穿过 iCloud / Google Backup 的管道。

## 快速开始

```dart
import 'package:remote_pi_identity/remote_pi_identity.dart';

final store = MethodChannelOwnerIdentityStore();

if (!await store.isSyncAvailable()) {
  // 展示对应平台的配置指引（比如「打开 iCloud Keychain」／
  // 「打开 Google Backup」）。不要把「仅本地身份」当作兜底 ——
  // 那会与同步形成静默分叉。
  return;
}

final existing = await store.load();
if (existing == null) {
  // 首次运行：用你选的加密库生成密钥对（example 用的是
  // package:cryptography），然后持久化。
  await store.save(OwnerIdentity(ownerPk: pk, ownerSk: sk));
}

// 响应同步到达（iOS）或恢复到新设备（Android）。
store.watch().listen((identity) {
  // 更新你的内存缓存。
});
```

完整演示（覆盖 generate / load / watch / delete / `isSyncAvailable`）见 [`example/lib/main.dart`](example/lib/main.dart)。

## API

包的公开面在 [`lib/remote_pi_identity.dart`](lib/remote_pi_identity.dart)：

```dart
class OwnerIdentity {
  final Uint8List ownerPk;    // 32 bytes
  final Uint8List ownerSk;    // 32 bytes
  Uint8List toBlob();         // 64 bytes: pk || sk
  static OwnerIdentity fromBlob(Uint8List blob);  // throws if length != 64
}

abstract class OwnerIdentityStore {
  Future<OwnerIdentity?> load();
  Future<void> save(OwnerIdentity identity);
  Stream<OwnerIdentity> watch();
  Future<void> delete();
  Future<bool> isSyncAvailable();
}
```

具体实现：

- `MethodChannelOwnerIdentityStore` —— 生产实现，对接 iOS / Android。
- `InMemoryOwnerIdentityStore` —— 供测试和 fake 使用。

错误以 sealed 的 `IdentityStoreError` 返回：

- `SyncUnavailable(reason)` —— iCloud Keychain / Google Backup 已关闭。推荐的 UX 是用平台相关的指引阻断首启流程（见 plan/23 §「Comportamento sem sync disponível」）。
- `PlatformFailure(code, message)` —— 来自原生侧的其他任何错误。按致命错误处理。

## 已知限制

- **Android 没有实时同步。** Block Store 只在恢复到新设备时传播 —— 它没有「值已变更」回调。如果你需要 iPhone 与 iPad 之间那样的实时同步，目前用 iOS；Android 实时同步在 `plan/26-android-live-sync.md` 里跟进。
- **不支持跨生态同步。** iOS 设备之间互相同步；Android 设备之间互相同步。两者之间没有通道。一个导出成助记词的方案（`plan/24-key-recovery-export.md`）或许最终能打通。
- **不支持按设备撤销。** 撤销 owner 密钥会抹掉这个人的本地同步面。按设备粒度的能力在 `plan/25-per-device-identity.md` 里跟进。

## 目录结构

```
remote_pi_identity/
├── lib/
│   ├── remote_pi_identity.dart    # public barrel
│   └── src/
│       ├── owner_identity.dart    # 64-byte OwnerIdentity (pk||sk)
│       ├── owner_identity_store.dart  # abstract interface + errors
│       ├── method_channel_store.dart  # production impl (iOS/Android)
│       └── in_memory_store.dart       # test / fake impl
├── ios/Classes/
│   ├── RemotePiIdentityPlugin.swift
│   └── KeychainSyncStore.swift
├── android/src/main/kotlin/dev/remotepi/identity/
│   ├── RemotePiIdentityPlugin.kt
│   └── BlockStoreStore.kt
├── example/                       # demo app
└── test/                          # serialization + in-memory tests
```

## 通道（供原生调试）

- method channel：`remote_pi_identity`
- event channel：`remote_pi_identity/events`

Dart 侧把序列化后的 64 字节 blob 以 `Uint8List` 传过去；原生侧只存／取字节，不检查内容。

## 另见

- `plan/23-owner-key-sync.md` —— 完整设计理由与路线图。
- `plan/00-decisions.md` —— monorepo 全局的既定决策。

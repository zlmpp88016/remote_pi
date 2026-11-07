import 'dart:io' show Platform;

import 'package:mobile/config/dependencies.dart';
import 'package:mobile/pairing/owner_identity_bridge.dart';
import 'package:mobile/ui/core/themes/themes.dart';
import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

/// Plan 23 — first-launch gate when the platform's key-sync surface
/// (iCloud Keychain on iOS, Google Backup / Block Store on Android) is
/// not available. The app cannot proceed without it because the Owner
/// Ed25519 keypair has no other persistence path.
class SyncRequiredPage extends StatefulWidget {
  const SyncRequiredPage({super.key});

  @override
  State<SyncRequiredPage> createState() => _SyncRequiredPageState();
}

class _SyncRequiredPageState extends State<SyncRequiredPage> {
  bool _checking = false;

  Future<void> _recheck() async {
    if (_checking) return;
    setState(() => _checking = true);
    final result = await injector.get<OwnerIdentityBridge>().boot();
    if (!mounted) return;
    setState(() => _checking = false);
    if (result is! SyncUnavailableResult) {
      // Bounce through /boot so the router's redirect logic re-evaluates
      // (pairs-empty → /onboarding, pairs-non-empty → /home).
      context.go('/boot');
    }
  }

  @override
  Widget build(BuildContext context) {
    final isIOS = Platform.isIOS;
    final requirements = isIOS ? _iosRequirements : _androidRequirements;
    final why = isIOS
        ? 'Remote Pi keeps your Ed25519 owner key in iCloud Keychain so '
              'you can switch iPhones or pair your iPad without scanning '
              'a new QR.'
        : 'Remote Pi 把 Ed25519 所有者密钥保存在 Google Block Store，'
              '也能通过 Google 备份恢复，不会丢失已配对的 Pi。';

    final colors = context.colors;
    return Scaffold(
      backgroundColor: colors.bg,
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 24),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const SizedBox(height: 24),
              Icon(
                isIOS ? LucideIcons.cloudOff : LucideIcons.cloudUpload,
                color: colors.accent,
                size: 44,
              ),
              const SizedBox(height: 20),
              Text(
                '需要开启同步',
                style: TextStyle(
                  fontFamily: kMonoFamily,
                  fontSize: 20,
                  fontWeight: FontWeight.w600,
                  color: colors.text,
                ),
              ),
              const SizedBox(height: 10),
              Text(
                why,
                style: TextStyle(
                  fontFamily: kMonoFamily,
                  fontSize: 12,
                  color: colors.muted2,
                  height: 1.4,
                ),
              ),
              const SizedBox(height: 20),
              Text(
                '在这台设备上需要：',
                style: TextStyle(
                  fontFamily: kMonoFamily,
                  fontSize: 11,
                  color: colors.muted,
                  fontWeight: FontWeight.w600,
                  letterSpacing: 0.4,
                ),
              ),
              const SizedBox(height: 10),
              Expanded(
                child: ListView.separated(
                  itemCount: requirements.length,
                  separatorBuilder: (_, _) => const SizedBox(height: 10),
                  itemBuilder: (_, i) => _RequirementCard(
                    index: i + 1,
                    requirement: requirements[i],
                  ),
                ),
              ),
              const SizedBox(height: 12),
              FilledButton(
                onPressed: _checking ? null : _recheck,
                style: FilledButton.styleFrom(
                  backgroundColor: colors.accent,
                  foregroundColor: colors.onAccent,
                  disabledBackgroundColor: colors.border,
                  padding: const EdgeInsets.symmetric(vertical: 14),
                  shape: const RoundedRectangleBorder(
                    borderRadius: BorderRadius.all(Radius.circular(6)),
                  ),
                ),
                child: _checking
                    ? SizedBox(
                        width: 18,
                        height: 18,
                        child: CircularProgressIndicator(
                          color: colors.onAccent,
                          strokeWidth: 2,
                        ),
                      )
                    : Text(
                        '重新检查',
                        style: TextStyle(
                          fontFamily: kMonoFamily,
                          fontSize: 14,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
              ),
              const SizedBox(height: 32),
            ],
          ),
        ),
      ),
    );
  }
}

class _Requirement {
  final String title;
  final String path;
  final String? note;
  const _Requirement({required this.title, required this.path, this.note});
}

const _androidRequirements = <_Requirement>[
  _Requirement(
    title: '设置屏幕锁定',
    path: '设置 › 安全 › 屏幕锁定',
    note: 'PIN、图案或生物识别 —— Block Store 要求必须有。',
  ),
  _Requirement(
    title: '开启 Google 备份',
    path: '设置 › 系统 › 备份\n'
        '（三星：设置 › 账户与备份 › 备份数据）',
  ),
  _Requirement(
    title: '登录 Google 账号',
    path: '设置 › 密码与账户 › 添加账户 › Google',
  ),
];

const _iosRequirements = <_Requirement>[
  _Requirement(
    title: '登录 iCloud',
    path: 'Settings › [your name]',
    note: '顶部若显示「登录你的 iPhone」，点它。',
  ),
  _Requirement(
    title: '开启 iCloud 钥匙串',
    path: 'Settings › [your name] › iCloud › Passwords and Keychain',
    note: '打开「同步此 iPhone」。',
  ),
];

class _RequirementCard extends StatelessWidget {
  final int index;
  final _Requirement requirement;
  const _RequirementCard({required this.index, required this.requirement});

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: colors.surface,
        border: Border.all(color: colors.border),
        borderRadius: const BorderRadius.all(Radius.circular(6)),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(
            width: 22,
            height: 22,
            alignment: Alignment.center,
            decoration: BoxDecoration(
              color: colors.accent.withValues(alpha: 0.15),
              borderRadius: const BorderRadius.all(Radius.circular(11)),
            ),
            child: Text(
              '$index',
              style: TextStyle(
                fontFamily: kMonoFamily,
                fontSize: 11,
                color: colors.accent,
                fontWeight: FontWeight.w600,
              ),
            ),
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  requirement.title,
                  style: TextStyle(
                    fontFamily: kMonoFamily,
                    fontSize: 13,
                    color: colors.text,
                    fontWeight: FontWeight.w600,
                  ),
                ),
                const SizedBox(height: 4),
                Text(
                  requirement.path,
                  style: TextStyle(
                    fontFamily: kMonoFamily,
                    fontSize: 11,
                    color: colors.muted2,
                    height: 1.4,
                  ),
                ),
                if (requirement.note != null) ...[
                  const SizedBox(height: 4),
                  Text(
                    requirement.note!,
                    style: TextStyle(
                      fontFamily: kMonoFamily,
                      fontSize: 10.5,
                      color: colors.muted,
                      height: 1.4,
                      fontStyle: FontStyle.italic,
                    ),
                  ),
                ],
              ],
            ),
          ),
        ],
      ),
    );
  }
}

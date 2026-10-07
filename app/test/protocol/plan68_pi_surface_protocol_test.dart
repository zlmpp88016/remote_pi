// Plan/68 W3b — protocol surface for the Pi (skills + packages).
// Mirrors `pi-extension/src/protocol/types.ts`:
//   ClientMessage:  pi_surface, skill_invoke, skill_set_enabled,
//                   package_install, package_remove, package_update
//   ServerMessage:  pi_surface_ok, skill_invoke_ok, skill_set_enabled_ok,
//                   package_op_ok
//
// These pin the exact JSON keys, because the payload is the contract between
// app and extension: a rename on one side has to fail here.

import 'package:app/protocol/protocol.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('plan/68 — Pi surface ClientMessage', () {
    test('PiSurface encodes as pi_surface', () {
      expect(PiSurface(id: 'r1').toJson(), {'type': 'pi_surface', 'id': 'r1'});
    });

    test('SkillInvoke omits empty args and keeps non-empty ones', () {
      expect(
        SkillInvoke(id: 'r2', name: 'pdf-tools').toJson(),
        {'type': 'skill_invoke', 'id': 'r2', 'name': 'pdf-tools'},
      );
      expect(
        SkillInvoke(id: 'r3', name: 'pdf-tools', args: 'extract a.pdf').toJson(),
        {
          'type': 'skill_invoke',
          'id': 'r3',
          'name': 'pdf-tools',
          'args': 'extract a.pdf',
        },
      );
    });

    test('SkillSetEnabled encodes the boolean flag', () {
      expect(
        SkillSetEnabled(id: 'r4', name: 'fmt', enabled: false).toJson(),
        {'type': 'skill_set_enabled', 'id': 'r4', 'name': 'fmt', 'enabled': false},
      );
    });

    test('PackageInstall encodes scope + confirm_third_party', () {
      expect(
        PackageInstall(
          id: 'r5',
          source: 'npm:@x/y@1',
          scope: PackageScope.project,
          confirmThirdParty: true,
        ).toJson(),
        {
          'type': 'package_install',
          'id': 'r5',
          'source': 'npm:@x/y@1',
          'scope': 'project',
          'confirm_third_party': true,
        },
      );
    });

    test('PackageRemove omits scope when unspecified', () {
      expect(
        PackageRemove(id: 'r6', source: 'npm:@x/y@1').toJson(),
        {'type': 'package_remove', 'id': 'r6', 'source': 'npm:@x/y@1'},
      );
    });

    test('PackageUpdate omits the source to reconcile everything', () {
      expect(PackageUpdate(id: 'r7').toJson(), {'type': 'package_update', 'id': 'r7'});
      expect(
        PackageUpdate(id: 'r8', source: 'npm:@x/y@1').toJson(),
        {'type': 'package_update', 'id': 'r8', 'source': 'npm:@x/y@1'},
      );
    });
  });

  group('plan/68 — Pi surface ServerMessage', () {
    test('pi_surface_ok decodes runtime, skills and packages', () {
      final msg = ServerMessage.fromJson(const {
        'type': 'pi_surface_ok',
        'in_reply_to': 'r1',
        'runtime': {'running': true, 'model': 'anthropic/claude-opus-4-7', 'thinking': 'medium'},
        'skills': [
          {
            'name': 'pdf-tools',
            'description': 'Extract text from PDFs',
            'source': 'user',
            'path': '/home/me/.pi/agent/skills/pdf-tools/SKILL.md',
            'enabled': true,
            'disable_model_invocation': false,
          },
          {
            'name': 'fmt',
            'description': 'Format code',
            'source': 'package',
            'path': '/pkg/skills/fmt/SKILL.md',
            'enabled': false,
            'disable_model_invocation': true,
          },
        ],
        'packages': [
          {'source': 'npm:@example/pi-tools@1.0.0', 'scope': 'project', 'resources': ['skills', 'prompts']},
        ],
      });
      expect(msg, isA<PiSurfaceOk>());
      final ok = msg as PiSurfaceOk;
      expect(ok.inReplyTo, 'r1');
      expect(ok.runtime.running, isTrue);
      expect(ok.runtime.model, 'anthropic/claude-opus-4-7');
      expect(ok.runtime.thinking, ThinkingLevel.medium);
      expect(ok.skills.map((s) => s.source), [SkillSource.user, SkillSource.package]);
      expect(ok.skills.last.disableModelInvocation, isTrue);
      expect(ok.skills.last.enabled, isFalse);
      expect(ok.packages.single.scope, PackageScope.project);
      expect(ok.packages.single.resources, ['skills', 'prompts']);
    });

    test('pi_surface_ok keeps null runtime fields null (never fabricated)', () {
      final ok = ServerMessage.fromJson(const {
        'type': 'pi_surface_ok',
        'in_reply_to': 'r1',
        'runtime': {'running': false, 'model': null, 'thinking': null},
        'skills': <Map<String, dynamic>>[],
        'packages': <Map<String, dynamic>>[],
      }) as PiSurfaceOk;
      expect(ok.runtime.running, isFalse);
      expect(ok.runtime.model, isNull);
      expect(ok.runtime.thinking, isNull);
      expect(ok.skills, isEmpty);
    });

    test('a skill with enabled: null stays null (the host could not tell)', () {
      final ok = ServerMessage.fromJson(const {
        'type': 'pi_surface_ok',
        'in_reply_to': 'r1',
        'runtime': <String, dynamic>{},
        'skills': [
          {'name': 'mystery', 'description': '', 'source': 'user', 'path': '/a', 'enabled': null},
        ],
        'packages': <Map<String, dynamic>>[],
      }) as PiSurfaceOk;
      expect(ok.skills.single.enabled, isNull);
    });

    test('an unknown skill source degrades to user instead of dropping the row', () {
      final ok = ServerMessage.fromJson(const {
        'type': 'pi_surface_ok',
        'in_reply_to': 'r1',
        'runtime': <String, dynamic>{},
        'skills': [
          {'name': 'weird', 'description': '', 'source': 'something-new', 'path': '/a', 'enabled': true},
        ],
        'packages': <Map<String, dynamic>>[],
      }) as PiSurfaceOk;
      expect(ok.skills.single.source, SkillSource.user);
    });

    test('skill_invoke_ok / skill_set_enabled_ok decode', () {
      final invoke = ServerMessage.fromJson(const {
        'type': 'skill_invoke_ok',
        'in_reply_to': 'r2',
        'name': 'pdf-tools',
      });
      expect(invoke, isA<SkillInvokeOk>());
      expect((invoke as SkillInvokeOk).name, 'pdf-tools');

      final toggled = ServerMessage.fromJson(const {
        'type': 'skill_set_enabled_ok',
        'in_reply_to': 'r3',
        'name': 'fmt',
        'enabled': false,
      });
      expect(toggled, isA<SkillSetEnabledOk>());
      expect((toggled as SkillSetEnabledOk).enabled, isFalse);
    });

    test('package_op_ok decodes each op and a null scope', () {
      final install = ServerMessage.fromJson(const {
        'type': 'package_op_ok',
        'in_reply_to': 'r5',
        'op': 'install',
        'source': 'npm:@x/y@1',
        'scope': 'user',
      }) as PackageOpOk;
      expect(install.op, PackageOp.install);
      expect(install.scope, PackageScope.user);

      final update = ServerMessage.fromJson(const {
        'type': 'package_op_ok',
        'in_reply_to': 'r7',
        'op': 'update',
        'source': '',
        'scope': null,
      }) as PackageOpOk;
      expect(update.op, PackageOp.update);
      expect(update.scope, isNull);
    });

    test('an unknown server type is an UnsupportedTypeException', () {
      expect(
        () => ServerMessage.fromJson(const {'type': 'nope'}),
        throwsA(isA<UnsupportedTypeException>()),
      );
    });
  });
}

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:gpt_markdown/gpt_markdown.dart';
import 'package:mobile/data/local/records/message_record.dart';
import 'package:mobile/domain/session_state.dart';
import 'package:mobile/ui/chat/chat_page.dart';
import 'package:mobile/ui/chat/render_metrics.dart';
import 'package:mobile/ui/chat/viewmodels/chat_viewmodel.dart';
import 'package:mobile/ui/chat/widgets/agent_markdown.dart';
import 'package:mobile/ui/chat/widgets/message_bubble.dart';
import 'package:mobile/ui/core/themes/themes.dart';

void main() {
  setUp(() {
    ChatRenderMetrics.enabled = true;
    ChatRenderMetrics.reset();
  });
  tearDown(() => ChatRenderMetrics.enabled = false);

  MessageRecord record(
    String id,
    String text, {
    MsgRole role = MsgRole.assistant,
  }) => MessageRecord(
    id: id,
    seq: 0,
    role: role,
    text: text,
    ts: DateTime.fromMillisecondsSinceEpoch(0),
  );

  test(
    'projection preserves row/list identity, roles and same-length changes',
    () {
      final projection = ChatMessageProjection();
      final first = projection.project([
        record('1', 'aaaa'),
        record('1', 'user', role: MsgRole.user),
      ]);
      final same = projection.project([
        record('1', 'aaaa'),
        record('1', 'user', role: MsgRole.user),
      ]);
      expect(identical(first, same), isTrue);
      expect(ChatRenderMetrics.projections, 2);
      final changed = projection.project([
        record('1', 'bbbb'),
        record('1', 'user', role: MsgRole.user),
      ]);
      expect(identical(first[0], changed[0]), isFalse);
      expect(identical(first[1], changed[1]), isTrue);
      expect((changed[0] as AssistantMsg).text, 'bbbb');
      expect(ChatRenderMetrics.projections, 3);
      final older = projection.project([
        record('old', 'past'),
        record('1', 'bbbb'),
        record('1', 'user', role: MsgRole.user),
      ]);
      expect(identical(older[1], changed[0]), isTrue);
      expect(identical(older[2], changed[1]), isTrue);
    },
  );

  testWidgets(
    'last row is a bubble without older pages; runtime rebuild reuses children',
    (tester) async {
      final projection = ChatMessageProjection();
      var messages = projection.project([
        record('1', 'reply'),
        record('1', 'user', role: MsgRole.user),
      ]);
      Future<void> pump({StreamingMessage? streaming}) => tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: ChatTranscriptList(
              messages: messages,
              streaming: streaming,
              onDecide: (_, _) {},
              hasOlder: false,
              onLoadOlder: () {},
            ),
          ),
        ),
      );
      await pump();
      expect(find.byType(AssistantBubble), findsOneWidget);
      expect(find.byType(UserBubble), findsOneWidget);
      final before = ChatRenderMetrics.snapshot;
      await pump();
      await pump(streaming: const StreamingMessage(inReplyTo: '1'));
      expect(ChatRenderMetrics.groupingPasses, before['groupingPasses']);
      expect(ChatRenderMetrics.assistantBuilds, before['assistantBuilds']);
      expect(ChatRenderMetrics.userBuilds, before['userBuilds']);
      expect(ChatRenderMetrics.markdownCreations, before['markdownCreations']);
      messages = projection.project([
        record('1', 'other'),
        record('1', 'user', role: MsgRole.user),
      ]);
      await pump();
      expect(ChatRenderMetrics.assistantBuilds, before['assistantBuilds']! + 1);
      expect(ChatRenderMetrics.userBuilds, before['userBuilds']);
      expect(
        ChatRenderMetrics.markdownCreations,
        before['markdownCreations']! + 1,
      );
      expect(
        tester.widget<GptMarkdown>(find.byType(GptMarkdown)).data,
        'other',
      );
    },
  );

  testWidgets(
    'Markdown instance reused until text/theme/font/width/scale/selectability changes',
    (tester) async {
      final themes = <(bool, double), ThemeData>{};
      GptMarkdown? previous;
      var revision = 0;
      Future<void> pump({
        String text = 'aaaa',
        bool light = false,
        double font = 13,
        double width = 400,
        double scale = 1,
        bool selectable = false,
      }) async {
        final creationsBefore = ChatRenderMetrics.markdownCreations;
        final theme = themes.putIfAbsent((light, font), () {
          final base = light ? buildLightTheme() : buildDarkTheme();
          final typo = base.extension<AppTypography>()!;
          return base.copyWith(
            extensions: [
              base.extension<AppColors>()!,
              typo.copyWith(mono: typo.mono.copyWith(fontSize: font)),
            ],
          );
        });
        await tester.pumpWidget(
          MaterialApp(
            theme: theme,
            themeAnimationDuration: Duration.zero,
            home: Scaffold(
              body: MediaQuery(
                data: MediaQueryData(textScaler: TextScaler.linear(scale)),
                child: SizedBox(
                  width: width,
                  child: AgentMarkdown(text, selectable: selectable),
                ),
              ),
            ),
          ),
        );
        await tester.pumpAndSettle();
        final current = tester.widget<GptMarkdown>(find.byType(GptMarkdown));
        final delta = ChatRenderMetrics.markdownCreations - creationsBefore;
        if (revision == 1) {
          expect(identical(previous, current), isTrue);
          expect(delta, 0);
        } else {
          expect(identical(previous, current), isFalse);
          expect(
            delta,
            inInclusiveRange(1, 2),
            reason:
                'one input revision, at most one inherited dependency update',
          );
        }
        previous = current;
        revision++;
      }

      await pump();
      final first = tester.widget<GptMarkdown>(find.byType(GptMarkdown));
      await pump();
      expect(
        identical(first, tester.widget<GptMarkdown>(find.byType(GptMarkdown))),
        isTrue,
      );
      expect(ChatRenderMetrics.markdownCreations, 1);
      await pump(text: 'bbbb');
      expect(tester.widget<GptMarkdown>(find.byType(GptMarkdown)).data, 'bbbb');
      await pump(text: 'bbbb', light: true);
      await pump(text: 'bbbb', light: true, font: 18);
      expect(
        tester.widget<GptMarkdown>(find.byType(GptMarkdown)).style?.fontSize,
        18,
      );
      await pump(text: 'bbbb', light: true, font: 18, width: 300);
      await pump(text: 'bbbb', light: true, font: 18, width: 300, scale: 1.5);
      await pump(
        text: 'bbbb',
        light: true,
        font: 18,
        width: 300,
        scale: 1.5,
        selectable: true,
      );

      expect(find.byType(SelectionArea), findsOneWidget);
    },
  );
}

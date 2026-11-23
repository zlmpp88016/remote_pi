// Plan 86 P4 — read-only history rows.
//
// These widgets render in-memory history items only. They deliberately take no
// SyncService, no Hive box and no send callback, so a read-only screen cannot
// mutate the live transcript or post a message. Bounded previews are shown by
// default; a `body_ref` can be expanded explicitly, and a failed/oversized
// expansion leaves the preview readable.

import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:mobile/domain/history/history_models.dart';
import 'package:mobile/ui/chat/widgets/agent_markdown.dart';
import 'package:mobile/ui/core/copy.dart';
import 'package:mobile/ui/core/themes/themes.dart';
import 'package:mobile/ui/history/history_labels.dart';
import 'package:mobile/ui/history/states/history_viewer_state.dart';

typedef HistoryBodyLookup =
    HistoryBodyState? Function(String eventId, HistoryBodyRef ref);
typedef HistoryBodyLoad = void Function(String eventId, HistoryBodyRef ref);

class HistoryItemTile extends StatelessWidget {
  const HistoryItemTile({
    super.key,
    required this.item,
    required this.bodyState,
    required this.onLoadBody,
  });

  final HistoryItem item;
  final HistoryBodyLookup bodyState;
  final HistoryBodyLoad onLoadBody;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final event = item.event;
    final content = switch (event) {
      HistoryUserEvent() => _UserTile(
        item: item,
        event: event,
        bodyState: bodyState,
        onLoadBody: onLoadBody,
      ),
      HistoryAssistantEvent() => _AssistantTile(
        item: item,
        event: event,
        bodyState: bodyState,
        onLoadBody: onLoadBody,
      ),
      HistoryToolRequestEvent() => _ToolTile(
        item: item,
        event: event,
        bodyState: bodyState,
        onLoadBody: onLoadBody,
      ),
      HistoryToolResultEvent() => _ToolResultTile(
        item: item,
        event: event,
        bodyState: bodyState,
        onLoadBody: onLoadBody,
      ),
      HistoryCompactionEvent() => _CompactionTile(
        item: item,
        event: event,
        bodyState: bodyState,
        onLoadBody: onLoadBody,
      ),
      HistoryUnknownEvent() => _UnknownTile(event: event),
    };
    if (!item.truncated) return content;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        content,
        Padding(
          padding: const EdgeInsets.fromLTRB(24, 2, 24, 6),
          child: Text(
            HistoryCopy.partialContent,
            style: TextStyle(color: colors.muted2, fontSize: 10),
          ),
        ),
      ],
    );
  }
}

HistoryBodyRef? _refFor(HistoryItem item, String field) {
  for (final ref in item.bodyRefs) {
    if (ref.field == field) return ref;
  }
  return null;
}

String? _loadedText(
  HistoryItem item,
  HistoryBodyRef? ref,
  HistoryBodyLookup lookup,
) {
  if (ref == null || !ref.previewTruncated) return null;
  final state = lookup(item.eventId, ref);
  if (state is HistoryBodyLoaded) return state.text;
  return null;
}

/// Expansion affordance for ONE truncated field. Returns null when the field
/// is complete, already fully shown, or has no ref.
Widget? _bodyControl(
  BuildContext context,
  HistoryItem item,
  HistoryBodyRef? ref,
  HistoryBodyLookup lookup,
  HistoryBodyLoad onLoad,
) {
  if (ref == null || !ref.previewTruncated) return null;
  final colors = context.colors;
  final state = lookup(item.eventId, ref);
  if (state is HistoryBodyLoaded) {
    // The full value is already painted in place of the preview.
    return null;
  }
  if (state is HistoryBodyLoading) {
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        SizedBox(
          width: 11,
          height: 11,
          child: CircularProgressIndicator(
            strokeWidth: 1.4,
            color: colors.accent,
          ),
        ),
        const SizedBox(width: 6),
        Text(
          HistoryCopy.loadingBody,
          style: TextStyle(color: colors.muted, fontSize: 11),
        ),
      ],
    );
  }
  if (state is HistoryBodyUnavailable) {
    return Text(
      historyFailureText(state.code),
      style: TextStyle(color: colors.error, fontSize: 11, height: 1.3),
    );
  }
  return TextButton(
    onPressed: () => onLoad(item.eventId, ref),
    style: TextButton.styleFrom(
      padding: const EdgeInsets.symmetric(horizontal: 0, vertical: 2),
      minimumSize: const Size(0, 24),
      tapTargetSize: MaterialTapTargetSize.shrinkWrap,
    ),
    child: Text(
      HistoryCopy.loadFull,
      style: TextStyle(color: colors.accent, fontSize: 11),
    ),
  );
}

class _Header extends StatelessWidget {
  const _Header({required this.icon, required this.label});
  final IconData icon;
  final String label;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Icon(icon, size: 13, color: colors.muted),
        const SizedBox(width: 6),
        Flexible(
          child: Text(
            label,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(
              color: colors.muted,
              fontSize: 11,
              fontFamily: kMonoFamily,
            ),
          ),
        ),
      ],
    );
  }
}

class _UserTile extends StatelessWidget {
  const _UserTile({
    required this.item,
    required this.event,
    required this.bodyState,
    required this.onLoadBody,
  });

  final HistoryItem item;
  final HistoryUserEvent event;
  final HistoryBodyLookup bodyState;
  final HistoryBodyLoad onLoadBody;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final textRef = _refFor(item, 'text');
    final fullText = _loadedText(item, textRef, bodyState) ?? event.text;
    final textControl = _bodyControl(
      context,
      item,
      textRef,
      bodyState,
      onLoadBody,
    );
    final imageRef = _refFor(item, 'images.0');
    final imageState = imageRef == null
        ? null
        : bodyState(item.eventId, imageRef);
    final inlineImage = _decodeInline(event.imageData);
    final loadedImage = imageState is HistoryBodyLoaded
        ? imageState.bytes
        : null;
    final imageBytes = loadedImage ?? inlineImage;
    final imageControl = _bodyControl(
      context,
      item,
      imageRef,
      bodyState,
      onLoadBody,
    );
    return Padding(
      padding: const EdgeInsets.fromLTRB(52, 8, 12, 8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.end,
        children: [
          const _Header(icon: LucideIcons.user, label: HistoryCopy.you),
          const SizedBox(height: 5),
          Container(
            decoration: BoxDecoration(
              color: colors.userBubble,
              borderRadius: BorderRadius.circular(12),
            ),
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 9),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.end,
              children: [
                if (imageBytes != null) ...[
                  ClipRRect(
                    borderRadius: BorderRadius.circular(8),
                    child: Image.memory(_u8(imageBytes), fit: BoxFit.contain),
                  ),
                  const SizedBox(height: 6),
                ] else if (imageRef != null) ...[
                  Text(
                    HistoryCopy.imageTooLarge,
                    style: TextStyle(color: colors.muted, fontSize: 11),
                  ),
                  const SizedBox(height: 4),
                ],
                SelectableText(
                  fullText,
                  style: TextStyle(
                    color: colors.text,
                    fontSize: 14,
                    height: 1.4,
                  ),
                ),
              ],
            ),
          ),
          if (textControl != null)
            Padding(padding: const EdgeInsets.only(top: 3), child: textControl),
          if (imageControl != null)
            Padding(
              padding: const EdgeInsets.only(top: 3),
              child: imageControl,
            ),
        ],
      ),
    );
  }
}

class _AssistantTile extends StatelessWidget {
  const _AssistantTile({
    required this.item,
    required this.event,
    required this.bodyState,
    required this.onLoadBody,
  });

  final HistoryItem item;
  final HistoryAssistantEvent event;
  final HistoryBodyLookup bodyState;
  final HistoryBodyLoad onLoadBody;

  @override
  Widget build(BuildContext context) {
    final textRef = _refFor(item, 'text');
    final text = _loadedText(item, textRef, bodyState) ?? event.text;
    final control = _bodyControl(context, item, textRef, bodyState, onLoadBody);
    return Padding(
      padding: const EdgeInsets.fromLTRB(12, 8, 40, 8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const _Header(icon: LucideIcons.sparkles, label: HistoryCopy.agent),
          const SizedBox(height: 4),
          AgentMarkdown(text, selectable: true),
          if (control != null)
            Padding(padding: const EdgeInsets.only(top: 3), child: control),
        ],
      ),
    );
  }
}

class _ToolTile extends StatelessWidget {
  const _ToolTile({
    required this.item,
    required this.event,
    required this.bodyState,
    required this.onLoadBody,
  });

  final HistoryItem item;
  final HistoryToolRequestEvent event;
  final HistoryBodyLookup bodyState;
  final HistoryBodyLoad onLoadBody;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final argsRef = _refFor(item, 'args');
    final fullArgs = _loadedText(item, argsRef, bodyState);
    final preview = fullArgs != null
        ? historyPrettyJson(fullArgs)
        : historyJsonPreview(event.args);
    final control = _bodyControl(context, item, argsRef, bodyState, onLoadBody);
    return Padding(
      padding: const EdgeInsets.fromLTRB(12, 6, 24, 6),
      child: Container(
        decoration: BoxDecoration(
          color: colors.surface.withValues(alpha: 0.55),
          borderRadius: BorderRadius.circular(8),
          border: Border.all(color: colors.border),
        ),
        padding: const EdgeInsets.all(10),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            _Header(
              icon: LucideIcons.wrench,
              label: '${HistoryCopy.toolCall} · ${event.tool}',
            ),
            if (preview.isNotEmpty) ...[
              const SizedBox(height: 6),
              SelectableText(
                preview,
                maxLines: fullArgs == null ? 6 : null,
                style: TextStyle(
                  color: colors.muted,
                  fontSize: 12,
                  fontFamily: kMonoFamily,
                  height: 1.35,
                ),
              ),
            ],
            if (control != null)
              Padding(padding: const EdgeInsets.only(top: 4), child: control),
          ],
        ),
      ),
    );
  }
}

class _ToolResultTile extends StatelessWidget {
  const _ToolResultTile({
    required this.item,
    required this.event,
    required this.bodyState,
    required this.onLoadBody,
  });

  final HistoryItem item;
  final HistoryToolResultEvent event;
  final HistoryBodyLookup bodyState;
  final HistoryBodyLoad onLoadBody;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final resultRef = _refFor(item, 'result');
    final fullResult = _loadedText(item, resultRef, bodyState);
    final preview = fullResult != null
        ? (resultRef?.representation == HistoryBodyRepresentation.jsonUtf8
              ? historyPrettyJson(fullResult)
              : fullResult)
        : historyJsonPreview(event.result);
    final control = _bodyControl(
      context,
      item,
      resultRef,
      bodyState,
      onLoadBody,
    );
    final errorRef = _refFor(item, 'error');
    final fullError = _loadedText(item, errorRef, bodyState);
    final errorControl = _bodyControl(
      context,
      item,
      errorRef,
      bodyState,
      onLoadBody,
    );
    final error = fullError ?? event.error;
    return Padding(
      padding: const EdgeInsets.fromLTRB(24, 2, 24, 8),
      child: Container(
        decoration: BoxDecoration(
          color: colors.surface.withValues(alpha: 0.35),
          borderRadius: BorderRadius.circular(8),
          border: Border.all(
            color: error != null ? colors.error : colors.border,
          ),
        ),
        padding: const EdgeInsets.all(9),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            _Header(
              icon: error != null ? LucideIcons.circleAlert : LucideIcons.check,
              label: HistoryCopy.toolResult,
            ),
            if (error != null) ...[
              const SizedBox(height: 5),
              Text(
                error,
                maxLines: fullError == null ? 5 : null,
                overflow: fullError == null ? TextOverflow.ellipsis : null,
                style: TextStyle(color: colors.error, fontSize: 12),
              ),
            ],
            if (errorControl != null)
              Padding(
                padding: const EdgeInsets.only(top: 4),
                child: errorControl,
              ),
            if (preview.isNotEmpty) ...[
              const SizedBox(height: 5),
              SelectableText(
                preview,
                maxLines: fullResult == null ? 6 : null,
                style: TextStyle(
                  color: colors.muted,
                  fontSize: 12,
                  fontFamily: kMonoFamily,
                  height: 1.35,
                ),
              ),
            ],
            if (control != null)
              Padding(padding: const EdgeInsets.only(top: 4), child: control),
          ],
        ),
      ),
    );
  }
}

class _CompactionTile extends StatelessWidget {
  const _CompactionTile({
    required this.item,
    required this.event,
    required this.bodyState,
    required this.onLoadBody,
  });
  final HistoryItem item;
  final HistoryCompactionEvent event;
  final HistoryBodyLookup bodyState;
  final HistoryBodyLoad onLoadBody;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final summaryRef = _refFor(item, 'summary');
    final fullSummary =
        _loadedText(item, summaryRef, bodyState) ?? event.summary;
    final control = _bodyControl(
      context,
      item,
      summaryRef,
      bodyState,
      onLoadBody,
    );
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 8),
      child: Container(
        width: double.infinity,
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
        decoration: BoxDecoration(
          color: colors.surface.withValues(alpha: 0.4),
          borderRadius: BorderRadius.circular(7),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              HistoryCopy.compaction,
              style: TextStyle(
                color: colors.muted,
                fontSize: 11,
                fontFamily: kMonoFamily,
              ),
            ),
            if (fullSummary.isNotEmpty) ...[
              const SizedBox(height: 4),
              Text(
                fullSummary,
                maxLines: summaryRef == null ? null : 4,
                overflow: summaryRef == null ? null : TextOverflow.ellipsis,
                style: TextStyle(color: colors.muted2, fontSize: 12),
              ),
            ],
            if (control != null)
              Padding(padding: const EdgeInsets.only(top: 4), child: control),
          ],
        ),
      ),
    );
  }
}

class _UnknownTile extends StatelessWidget {
  const _UnknownTile({required this.event});
  final HistoryUnknownEvent event;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 6),
      child: Text(
        '${HistoryCopy.unknownEvent} ${event.type}',
        style: TextStyle(color: colors.muted2, fontSize: 11),
      ),
    );
  }
}

List<int>? _decodeInline(String? base64Text) {
  if (base64Text == null || base64Text.isEmpty) return null;
  try {
    return base64Decode(base64Text);
  } catch (_) {
    return null;
  }
}

// `Image.memory` needs a Uint8List; keep the conversion in one place so a
// `List<int>` from the body loader never reaches it directly.
Uint8List _u8(List<int> bytes) =>
    bytes is Uint8List ? bytes : Uint8List.fromList(bytes);

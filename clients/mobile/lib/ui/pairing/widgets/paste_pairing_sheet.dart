import 'package:app/ui/core/themes/themes.dart';
import 'package:app/ui/pairing/states/pairing_state.dart';
import 'package:app/ui/pairing/viewmodels/pairing_viewmodel.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

/// Bottom sheet with the plan/69 W1 pairing form: TWO fields —
///
///   * **Address** (relay): auto-filled from the code's `r=` param when
///     present, fully editable, and empty means "use the default relay
///     from Preferences" (shown as the placeholder).
///   * **Pairing code**: the full `remotepi://pair?…` URI pasted from the
///     computer running `/remote-pi pair`.
///
/// No camera, no scan (plan/68). The sheet drives [PairingViewModel]'s
/// form state directly, so validation errors are typed
/// (`PairingValidationCode`) and shown inline under the offending field.
/// The sheet closes itself as soon as the pairing attempt actually starts
/// (state leaves the form); typed validation failures keep it open so the
/// user can fix the field in place.
Future<void> showPastePairingSheet(
  BuildContext context, {
  required PairingViewModel vm,
}) async {
  await showModalBottomSheet<void>(
    context: context,
    backgroundColor: context.colors.bg,
    isScrollControlled: true,
    builder: (sheetCtx) {
      return Padding(
        padding: EdgeInsets.only(
          bottom: MediaQuery.of(sheetCtx).viewInsets.bottom,
        ),
        child: _PasteQrSheetBody(vm: vm),
      );
    },
  );
}

class _PasteQrSheetBody extends StatefulWidget {
  final PairingViewModel vm;
  const _PasteQrSheetBody({required this.vm});

  @override
  State<_PasteQrSheetBody> createState() => _PasteQrSheetBodyState();
}

class _PasteQrSheetBodyState extends State<_PasteQrSheetBody> {
  late final TextEditingController _addressController;
  late final TextEditingController _codeController;
  bool _closing = false;

  PairingViewModel get _vm => widget.vm;

  @override
  void initState() {
    super.initState();
    // Seed the fields with whatever the ViewModel already holds (e.g. a
    // previous attempt's values after "Try again").
    _addressController = TextEditingController(text: _vm.address);
    _codeController = TextEditingController(text: _vm.code);
    _vm.addListener(_onVmChanged);
  }

  @override
  void dispose() {
    _vm.removeListener(_onVmChanged);
    _addressController.dispose();
    _codeController.dispose();
    super.dispose();
  }

  /// Keep the text fields in sync with the ViewModel (auto-fill of the
  /// address from the code's `r=`) and close the sheet once the pairing
  /// attempt leaves the form (connecting / paired / flow error — the page
  /// renders those states).
  void _onVmChanged() {
    if (!mounted) return;
    final state = _vm.state;
    final leftForm = state is! PairingScanning && state is! PairingIdle;
    if (leftForm) {
      if (!_closing) {
        _closing = true;
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (!mounted) return;
          Navigator.of(context).maybePop();
        });
      }
      return;
    }
    if (_addressController.text != _vm.address) {
      _addressController.text = _vm.address;
      _addressController.selection = TextSelection.collapsed(
        offset: _vm.address.length,
      );
    }
    // Rebuild so canSubmit / validationError / the auto-filled address are
    // reflected (the sheet is a pure view of the ViewModel form state).
    setState(() {});
  }

  Future<void> _pasteInto(TextEditingController controller, bool isCode) async {
    final data = await Clipboard.getData(Clipboard.kTextPlain);
    final text = data?.text?.trim();
    if (text == null || text.isEmpty) return;
    controller.text = text;
    controller.selection = TextSelection.collapsed(offset: text.length);
    if (isCode) {
      _vm.onCodeChanged(text);
    } else {
      _vm.onAddressChanged(text);
    }
  }

  void _submit() {
    if (!_vm.canSubmit) return;
    // Validation runs inside submitPairing; on a typed failure the state
    // stays on the form and the sheet remains open showing the error.
    _vm.submitPairing();
  }

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final error = _vm.validationError;
    final addressError = switch (error?.code) {
      PairingValidationCode.invalidRelay ||
      PairingValidationCode.relayMismatch => error?.message,
      _ => null,
    };
    final codeError = switch (error?.code) {
      PairingValidationCode.invalidPayload => error?.message,
      _ => null,
    };

    return SafeArea(
      top: false,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(20, 16, 20, 20),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Container(
              alignment: Alignment.center,
              padding: const EdgeInsets.only(bottom: 12),
              child: Container(
                width: 40,
                height: 4,
                decoration: BoxDecoration(
                  color: colors.border,
                  borderRadius: BorderRadius.circular(2),
                ),
              ),
            ),
            Text(
              'Pair device',
              style: TextStyle(
                fontFamily: kMonoFamily,
                fontSize: 15,
                fontWeight: FontWeight.w600,
                color: colors.text,
              ),
            ),
            const SizedBox(height: 6),
            Text(
              "Run /remote-pi pair on your computer and paste the code it "
              "prints. The relay address fills in automatically.",
              style: TextStyle(
                fontFamily: kMonoFamily,
                fontSize: 11,
                color: colors.muted,
                height: 1.4,
              ),
            ),
            const SizedBox(height: 16),
            _FieldLabel('Relay address'),
            const SizedBox(height: 6),
            TextField(
              key: const Key('pairing-sheet-address'),
              controller: _addressController,
              onChanged: _vm.onAddressChanged,
              autocorrect: false,
              enableSuggestions: false,
              textCapitalization: TextCapitalization.none,
              keyboardType: TextInputType.url,
              style: TextStyle(
                fontFamily: kMonoFamily,
                fontSize: 12,
                color: colors.text,
              ),
              decoration: _fieldDecoration(
                colors,
                hintText: _vm.defaultRelayUrl,
                helperText: 'Leave empty to use the default relay',
                errorText: addressError,
                suffix: IconButton(
                  icon: Icon(
                    LucideIcons.clipboardPaste,
                    size: 14,
                    color: colors.muted,
                  ),
                  tooltip: 'Paste address',
                  onPressed: () => _pasteInto(_addressController, false),
                ),
              ),
            ),
            const SizedBox(height: 14),
            _FieldLabel('Pairing code'),
            const SizedBox(height: 6),
            TextField(
              key: const Key('pairing-sheet-code'),
              controller: _codeController,
              onChanged: _vm.onCodeChanged,
              minLines: 3,
              maxLines: 6,
              autocorrect: false,
              enableSuggestions: false,
              textCapitalization: TextCapitalization.none,
              keyboardType: TextInputType.url,
              style: TextStyle(
                fontFamily: kMonoFamily,
                fontSize: 12,
                color: colors.text,
              ),
              decoration: _fieldDecoration(
                colors,
                hintText: 'remotepi://pair?t=…',
                errorText: codeError,
              ),
            ),
            const SizedBox(height: 12),
            OutlinedButton.icon(
              onPressed: () => _pasteInto(_codeController, true),
              icon: Icon(
                LucideIcons.clipboardPaste,
                size: 16,
                color: colors.accent,
              ),
              label: Text(
                'Paste code from clipboard',
                style: TextStyle(
                  fontFamily: kMonoFamily,
                  fontSize: 12,
                  color: colors.accent,
                ),
              ),
              style: OutlinedButton.styleFrom(
                side: BorderSide(color: colors.border),
                padding: const EdgeInsets.symmetric(vertical: 12),
                shape: const RoundedRectangleBorder(
                  borderRadius: BorderRadius.all(Radius.circular(6)),
                ),
              ),
            ),
            const SizedBox(height: 12),
            FilledButton(
              key: const Key('pairing-sheet-submit'),
              onPressed: _vm.canSubmit ? _submit : null,
              style: FilledButton.styleFrom(
                backgroundColor: colors.accent,
                foregroundColor: colors.onAccent,
                disabledBackgroundColor: colors.border,
                padding: const EdgeInsets.symmetric(vertical: 14),
                shape: const RoundedRectangleBorder(
                  borderRadius: BorderRadius.all(Radius.circular(6)),
                ),
              ),
              child: const Text(
                'Pair',
                style: TextStyle(
                  fontFamily: kMonoFamily,
                  fontSize: 14,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  InputDecoration _fieldDecoration(
    AppColors colors, {
    required String hintText,
    String? helperText,
    String? errorText,
    Widget? suffix,
  }) {
    return InputDecoration(
      isDense: true,
      hintText: hintText,
      helperText: helperText,
      helperStyle: TextStyle(fontFamily: kMonoFamily, color: colors.muted),
      errorText: errorText,
      errorStyle: TextStyle(
        fontFamily: kMonoFamily,
        color: colors.error,
        fontSize: 11,
      ),
      errorMaxLines: 4,
      hintStyle: TextStyle(fontFamily: kMonoFamily, color: colors.muted),
      filled: true,
      fillColor: colors.surface,
      contentPadding: const EdgeInsets.symmetric(
        horizontal: 12,
        vertical: 12,
      ),
      suffixIcon: suffix,
      enabledBorder: OutlineInputBorder(
        borderSide: BorderSide(color: colors.border),
      ),
      focusedBorder: OutlineInputBorder(
        borderSide: BorderSide(color: colors.accent),
      ),
    );
  }
}

class _FieldLabel extends StatelessWidget {
  final String text;
  const _FieldLabel(this.text);

  @override
  Widget build(BuildContext context) {
    return Text(
      text,
      style: TextStyle(
        fontFamily: kMonoFamily,
        fontSize: 11,
        fontWeight: FontWeight.w600,
        color: context.colors.muted,
      ),
    );
  }
}

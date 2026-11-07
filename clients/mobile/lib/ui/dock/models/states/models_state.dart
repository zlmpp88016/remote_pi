import 'package:mobile/protocol/models.dart';

/// 模型面板的状态。
sealed class ModelsState {
  const ModelsState();
}

class ModelsLoading extends ModelsState {
  const ModelsLoading();
}

class ModelsReady extends ModelsState {
  final ModelsSnapshot snapshot;
  const ModelsReady(this.snapshot);
}

/// 主机明确拒绝。
class ModelsRefused extends ModelsState {
  final ModelsErrorReason reason;
  const ModelsRefused(this.reason);
}

/// 主机根本没声明 `models_config` 能力。
///
/// 与 [ModelsRefused] 不同：那是发出了请求后被拒，这是**从未发请求**。
class ModelsUnsupported extends ModelsState {
  const ModelsUnsupported();
}

class ModelsError extends ModelsState {
  const ModelsError();
}

class ModelsSaving extends ModelsState {
  final ModelsSnapshot snapshot;
  const ModelsSaving(this.snapshot);
}

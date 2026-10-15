import 'package:mobile/domain/contracts/disposable.dart';

abstract class Service implements Disposable {
  @override
  void dispose() {}
}

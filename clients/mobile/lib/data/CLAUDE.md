# Camada `data/`

## Propósito

Traduzir contratos de `domain/` em chamadas para integrações externas
(rede, banco, plataforma), aplicando caches, mapeadores e repositórios
especializados. Esta camada é a fronteira entre regras de negócio puras e o
mundo bagunçado de I/O.

## Deve fazer

1. **Implementar contratos do domínio** — cada interface declarada em
   `domain/repositories/` ou `domain/services/` tem sua implementação concreta
   aqui.
2. **Traduzir DTOs** — adapters/mappers convertem modelos de transporte
   (JSON, rows do banco) em entidades de domínio e vice-versa.
3. **Orquestrar fontes múltiplas** — combinar cache local, API remota,
   storage, expondo uma API simples aos use cases.
4. **Propagar falhas contextualizadas** — capturar exceções técnicas das
   integrações e convertê-las em erros compreensíveis pelo domínio.

   Padrão obrigatório em APIs (`data/apis/`):

   ```dart
   try {
     // chamada de rede / IO
   } on DioException catch (e, s) {
     return Failure(
       AppException.create(
         'Mensagem contextualizada.',
         stackTrace: s,
         originalError: e,
       ),
     );
   } catch (e, s) {
     return Failure(
       AppException.fatal(
         'Erro inesperado.',
         stackTrace: s,
         originalError: e,
       ),
     );
   }
   ```

   Regras:
   - `DioException` (erro de rede/HTTP) → `AppException.create(...)`
   - Erro genérico/inesperado → **sempre** `AppException.fatal(...)`
   - Stack trace: use o `s` capturado, evite `StackTrace.current` dentro do
     `catch`
   - Contrato inválido / dados ausentes → preferir
     `Failure(AppException.create('...'))` para mensagens legíveis e
     rastreamento consistente pelo observer global

5. **Manter contratos explícitos** — interfaces vivem no domínio,
   implementações moram aqui (nunca o contrário).

## Não deve fazer

1. **Implementar regras de negócio** — decisões de domínio (validações,
   cálculos, políticas) permanecem em `domain/`.
2. **Consumir UI** — nenhum import de `ui/`, `widget`, `BuildContext`.
3. **Acessar `auto_injector` direto** fora do setup — instâncias são
   fornecidas via `config/dependencies.dart`.
4. **Duplicar lógica de infraestrutura** — clientes HTTP, WebSocket, mDNS
   ficam encapsulados em `data/services/`, não espalhados.

## Estrutura sugerida

```
data/
├── adapters/         # mappers DTO ↔ entidade (por agregado)
├── apis/             # clients HTTP (cada um implementa um contrato)
├── repositories/     # implementações de repositórios do domínio
├── services/         # implementações de serviços do domínio (mDNS, WS, ...)
└── usecases/         # implementações de use cases que dependem de IO
```

## Vocabulário

- **Repository** — implementação concreta que satisfaz um contrato do domínio
  usando fontes de dados.
- **Data Source** — fonte específica (remota, local, cache) usada por um
  repositório.
- **Adapter / Mapper** — objeto que converte DTOs de serviço em entidades
  de domínio.
- **Sync Strategy** — política que define quando buscar remoto, servir cache,
  ou mesclar resultados.

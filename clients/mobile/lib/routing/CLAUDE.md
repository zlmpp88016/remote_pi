# Camada `routing/`

## Propósito

Descrever e coordenar as rotas do aplicativo, conectando paths a páginas/flows
sem infiltrar lógica de UI ou domínio. Esta camada sustenta o `GoRouter`,
define guardas e garante consistência entre rotas declaradas e a navegação
real.

## Deve fazer

1. **Centralizar paths** — manter constantes (ex.: `routePaths`) para evitar
   strings mágicas e facilitar refactors.
2. **Definir topologia de navegação** — rotas, shells, branches e
   redirecionamentos vivem aqui.
3. **Delegar construção de páginas** — cada rota instancia apenas o widget raiz
   correspondente (ex.: `HomeRoute`); a feature em `ui/` cuida do conteúdo.
4. **Aplicar middlewares/guards** — autenticação, checagens de permissão,
   onboarding encapsulados em `redirect`/route guards.
5. **Documentar fluxos** — sempre deixar claro qual rota inicia cada módulo e
   como o usuário retorna.
6. **Injetar ViewModels na árvore** — a composição de `MultiProvider` e
   `ViewmodelProvider`s acontece exclusivamente em `routing/router.dart`,
   garantindo um único ponto de orquestração por rota.

## Não deve fazer

1. **Acessar stores ou serviços diretamente** — lógica de negócio fica no
   domínio e a UI consome via ViewModels.
2. **Criar side effects globais** — nada de inicializações ou tracking aqui;
   apenas navegação.
3. **Duplicar rotas em features** — qualquer ajuste de path passa por
   `routing/` para evitar inconsistências.
4. **Misturar responsabilidades** — evite widgets inline ou lógicas
   específicas de feature; use apenas widgets declarados em `ui/`.

## Estrutura sugerida

```
routing/
├── router.dart          # GoRouter + MultiProvider/ViewmodelProvider
├── routes.dart          # constantes de path (routePaths.home, ...)
└── guards.dart          # redirect logic (auth, onboarding, ...)
```

## Vocabulário

- **Route Path** — string declarada em `routes.dart` que identifica uma
  navegação.
- **Shell Route** — estrutura que guarda estado de navegação (ex.: tabs) e
  injeta `NavigationShell`.
- **Route Guard** — função de verificação antes do `builder`/`pageBuilder`.
- **Entry Widget** — widget superior de uma feature (ex.: `HomeRoute`)
  responsável por providers e wrappers.

# Camada `domain/`

## Propósito

Materializar o conhecimento do negócio. Aqui vivem modelos, casos de uso e
validadores com regras determinísticas, **independentes de UI, banco ou rede**.
Esta camada é o núcleo — todas as outras dependem dela; ela não depende de
nenhuma.

## Deve fazer

1. **Modelar entidades e value objects** com imutabilidade e igualdade
   consistente (`==` / `hashCode`).
2. **Orquestrar regras via Use Cases**: cada `*UseCase` expõe um único verbo do
   domínio e delega integrações aos contratos (`repositories/`, `services/`).
3. **Validar invariantes** em `validators/`, lançando exceções tipadas
   (`ValidationException`, `DomainException`).
4. **Manter pureza**: código síncrono ou assíncrono previsível, sem side
   effects além de chamadas a contratos.
5. **Expor contratos**: interfaces (abstratas) de repositórios e serviços moram
   aqui — implementações concretas vivem em `data/`.

## Não deve fazer

1. **Importar Flutter** — nada de `BuildContext`, widgets, `Material`,
   `Cupertino`. Use Dart puro.
2. **Acessar infraestrutura diretamente** — bancos, HTTP, mDNS, platform
   channels pertencem a `data/services/`.
3. **Guardar estado mutável global** — evite singletons; objetos vêm pelo
   injector quando necessário.
4. **Duplicar lógica** — reutilize validators e models existentes em vez de
   recriar regras em cada use case.
5. **Conhecer detalhes de transporte** — se uma regra precisa decidir entre
   "buscar do cache ou da rede", essa decisão é de `data/`, não daqui.

## Estrutura sugerida

```
domain/
├── entities/           # objetos com identidade (id + ciclo de vida)
│   └── <agregado>/
├── value_objects/      # valores imutáveis sem identidade (Email, CPF, ...)
├── dtos/               # objetos de transferência entre camadas
├── contracts/          # interfaces de baixo nível (clients, gateways)
├── repositories/       # interfaces de repositório
├── services/           # interfaces de serviço de domínio
├── usecases/           # operações unitárias (1 verbo cada)
├── validators/         # invariantes e regras de validação
└── exceptions/         # exceções tipadas do domínio
```

## Vocabulário

- **Entidade** — objeto com identidade (`id`) e ciclo de vida próprio.
- **Value Object** — valor imutável sem identidade (ex.: `Email`, `Hostname`).
- **Use Case** — operação unitária do domínio exposta à aplicação.
- **Invariante** — regra que sempre precisa ser verdadeira para o domínio
  continuar consistente.
- **Contrato** — interface declarada no domínio e implementada em `data/`.

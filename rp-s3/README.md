# rp-s3 — servidor de downloads do Remote Pi

Servidor HTTP mínimo (Rust + axum) que serve os instaladores do Cockpit (e
futuros produtos) a partir de um diretório montado como volume. Roda em
container na VPS atrás do proxy que termina TLS em
`https://rp-s3.example.invalid`.

É o lado "leitura" do passo 4 do [plano 43](../plan/43-cockpit-packaging.md).
A VPS não tem acesso SSH, então o fluxo é: o CI (`cockpit-release.yml`)
publica os binários como assets da **GitHub Release** `cockpit-v<versão>` e
publica o `latest.json`/appcast direto neste host via `PUT /upload` (token
Bearer). O rp-s3 serve o manifest na URL estável que o site consome.

## Rotas

| Rota | Comportamento |
|---|---|
| `GET /healthz` | `200 ok` |
| `GET /downloads/<produto>/...` | arquivos de `DATA_DIR/<produto>/...` |
| `PUT /upload/<produto>/<arquivo>` | grava manifest no volume (auth Bearer) |

### Upload de manifests

Só existe se `UPLOAD_TOKEN` estiver setado (sem env → 404, fluxo manual).
Aceita **apenas** `latest.json`, `SHA256SUMS` e `*.xml` (appcast do Sparkle)
— binários continuam nos assets da GitHub Release. Escrita é atômica
(tmp + rename), então quem baixa nunca vê manifest pela metade.

Chamada a partir do GitHub Actions (token guardado como secret do repo —
secrets não vazam pra fork/PR, então na prática só o nosso repo publica):

```yaml
- name: Publish manifest
  run: |
    curl -fsS -X PUT \
      -H "Authorization: Bearer ${{ secrets.RP_S3_UPLOAD_TOKEN }}" \
      --data-binary @latest.json \
      https://rp-s3.example.invalid/upload/cockpit/latest.json
```

> Por que token e não "verificar o repositório"? Um header com o nome do
> repo é forjável. A alternativa criptográfica seria OIDC do GitHub Actions
> (JWT assinado, claim `repository`) — upgrade possível no mesmo endpoint,
> mas desproporcional pro tamanho deste servidor hoje.

Regras de resposta em `/downloads`:

- `.dmg`/`.exe`/`.deb`/`.rpm`/`.zip` → `Content-Disposition: attachment` +
  `Cache-Control: immutable, 1 ano` (artefatos vivem em pastas versionadas,
  a URL nunca é reusada).
- Demais arquivos (`latest.json`, `SHA256SUMS`) → `Cache-Control: max-age=300`
  (URL fixa, release novo propaga em ≤5 min).
- `Access-Control-Allow-Origin: *` em tudo (o site lê o manifest de outro
  domínio).
- Sem listagem de diretório; diretório sem index → 404.

## Configuração

| Env | Default | Descrição |
|---|---|---|
| `DATA_DIR` | `/data` | raiz servida em `/downloads` |
| `PORT` | `8080` | porta HTTP (TLS fica no proxy) |
| `UPLOAD_TOKEN` | — | habilita `PUT /upload`; ausente = endpoint desligado |
| `RUST_LOG` | `rp_s3=info,tower_http=info` | nível de log |

## Layout do volume

O `docker-compose.yml` monta o deploy path do CI **como o subdiretório do
produto** — assim o host fica plano e a URL ganha o prefixo certo:

```
host:  /home/user/cockpit/data/          (gravado via PUT /upload)
         latest.json
         SHA256SUMS                              (opcional)

mount: /home/user/cockpit/data → /data/cockpit (rw, pro upload)

URL:   https://rp-s3.example.invalid/downloads/cockpit/latest.json
```

Os binários em si vivem nos assets da GitHub Release — as URLs dentro do
`latest.json` apontam pra lá. O servidor continua sabendo servir
`.dmg`/`.exe`/`.deb`/`.rpm` como attachment caso um dia algum arquivo seja
hospedado aqui também.

Produto novo no futuro = outro volume montado em `/data/<produto>`.

## Rodar

```bash
# local, sem docker
DATA_DIR=./exemplo PORT=8080 cargo run

# na VPS (puxa a imagem do Docker Hub)
docker compose pull && docker compose up -d
curl -fsS http://localhost:8080/healthz
```

## Publicar no Docker Hub

Mesmo fluxo do relay: o script lê a versão do `Cargo.toml`, builda multiarch
(amd64+arm64) via buildx e publica `exampleorg/rp-s3:v<versão>` + `:latest`.

```bash
docker login          # uma vez
./push-docker.sh
```

O proxy reverso da VPS aponta `rp-s3.example.invalid` → `localhost:8080`.

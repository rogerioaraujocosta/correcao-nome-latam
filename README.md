# Bot local de correção de nome via WhatsApp — LATAM

Projeto open source para conduzir, em uma conta de WhatsApp autorizada, o fluxo de solicitação de correção de nome usado no atendimento da LATAM. O bot roda localmente, conecta-se ao WhatsApp por QR Code com Baileys e só reage a mensagens novas do número configurado pelo operador.

> [!WARNING]
> Este é um projeto independente e não oficial. Não é afiliado, patrocinado, aprovado ou mantido pela LATAM Airlines Group, pela Meta, pelo WhatsApp ou pelos mantenedores do Baileys. A integração usa uma interface não oficial do WhatsApp e pode parar de funcionar ou provocar restrições na sessão/conta. Use somente uma conta autorizada, sem spam, e respeite os termos aplicáveis, a LGPD e as regras do canal atendido.

## Comece aqui

### Para iniciar o bot no dia a dia

Se o projeto **já foi instalado e configurado**, abra um terminal dentro da pasta do projeto e execute somente:

```bash
npm start
```

O terminal precisa permanecer aberto enquanto o bot estiver funcionando. Para encerrar com segurança, pressione `Ctrl+C`.

Se o terminal não estiver na pasta do projeto, use o comando completo do seu sistema:

Windows PowerShell:

```powershell
Set-Location -LiteralPath (Join-Path $HOME 'correcao-nome-latam'); npm start
```

macOS:

```bash
cd "$HOME/correcao-nome-latam" && npm start
```

### Primeira instalação: baixar do GitHub e configurar

#### Windows — PowerShell

O bloco abaixo baixa todo o projeto do GitHub para a pasta `correcao-nome-latam` do usuário, entra nela e inicia o instalador guiado. Não é necessário ter Git nem Node.js previamente instalado.

Copie e cole o bloco inteiro no PowerShell:

```powershell
$repo = 'https://github.com/rogerioaraujocosta/correcao-nome-latam'
$destino = Join-Path $HOME 'correcao-nome-latam'
$temporario = Join-Path ([IO.Path]::GetTempPath()) ('correcao-nome-latam-' + [guid]::NewGuid().ToString('N'))
if (Test-Path -LiteralPath $destino) { throw "A pasta já existe: $destino" }
New-Item -ItemType Directory -Path $temporario | Out-Null
try {
    $zip = Join-Path $temporario 'projeto.zip'
    Invoke-WebRequest -Uri "$repo/archive/refs/heads/main.zip" -OutFile $zip
    Expand-Archive -LiteralPath $zip -DestinationPath $temporario
    Move-Item -LiteralPath (Join-Path $temporario 'correcao-nome-latam-main') -Destination $destino
}
finally {
    if (Test-Path -LiteralPath $temporario) {
        Remove-Item -LiteralPath $temporario -Recurse -Force
    }
}
Set-Location -LiteralPath $destino
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1
```

#### macOS — Terminal

O bloco abaixo baixa todo o projeto para `~/correcao-nome-latam`, entra na pasta e inicia o instalador guiado. Não é necessário ter Git nem Node.js previamente instalado.

Copie e cole o bloco inteiro no Terminal:

```bash
REPO='https://github.com/rogerioaraujocosta/correcao-nome-latam'
DESTINO="$HOME/correcao-nome-latam"
test ! -e "$DESTINO" || { echo "A pasta já existe: $DESTINO"; exit 1; }
TEMPORARIO="$(mktemp -d)" || exit 1
trap 'rm -rf -- "$TEMPORARIO"' EXIT
curl --fail --location --proto '=https' --tlsv1.2 \
  "$REPO/archive/refs/heads/main.zip" \
  --output "$TEMPORARIO/projeto.zip" || exit 1
unzip -q "$TEMPORARIO/projeto.zip" -d "$TEMPORARIO" || exit 1
mv "$TEMPORARIO/correcao-nome-latam-main" "$DESTINO" || exit 1
rm -rf -- "$TEMPORARIO"
trap - EXIT
cd "$DESTINO" || exit 1
/bin/bash ./scripts/install.sh
```

### O que acontece na primeira instalação

O instalador verifica o Node.js, oferece a instalação automática do Node 24 LTS quando necessário, instala as dependências, executa os testes e abre o assistente de configuração. No assistente:

1. informe o número da conversa da LATAM que será monitorada, com DDI e DDD;
2. conclua a configuração;
3. execute `npm start`;
4. leia o QR Code mostrado no terminal em **WhatsApp > Dispositivos conectados > Conectar um dispositivo**.

Depois disso, nas próximas utilizações, o único comando necessário para iniciar será:

```bash
npm start
```

### Comandos principais

| Objetivo | Comando |
| --- | --- |
| Iniciar o bot | `npm start` |
| Executar novamente a configuração inicial | `npm run setup` |
| Alterar o número monitorado | `npm run config:number` |
| Reconectar ou gerar outro QR | `npm run reconnect` |
| Excluir a conexão do WhatsApp | `npm run connection:delete` |
| Ver o estado do bot | `npm run status` |

## O que o projeto faz

- Lê o QR Code no próprio terminal e mantém a autenticação somente na máquina do usuário.
- Expõe um webhook HTTP local autenticado para receber PNR, nomes e o PDF do bilhete.
- Envia `Olá` quando um trabalho entra na fila e o WhatsApp está conectado.
- Aguarda uma resposta nova do número monitorado antes de enviar cada mensagem seguinte.
- Ignora mensagens de outros números, grupos e histórico sincronizado; uma mensagem manual enviada pela própria conta pausa o trabalho para revisão.
- Mantém fila, idempotência, timeouts e estados de recuperação para evitar reenvios cegos.
- Permite alterar o número monitorado, reconectar, forçar novo QR e excluir a conexão.
- Mantém credenciais, token, PDFs, configuração pessoal e trabalhos na área privada do usuário, fora do repositório Git.

O QR Code **não gera um webhook**. São duas partes diferentes:

```mermaid
flowchart LR
    A["Sistema ou operador"] -->|"POST local + Bearer token"| B["Webhook HTTP"]
    B --> C["Fila e workflow local"]
    C -->|"mensagens e PDF"| D["Baileys"]
    D --> E["Conversa com o número monitorado"]
    E -->|"respostas novas"| D
    D -->|"messages.upsert filtrado"| C
```

O servidor HTTP recebe os dados da correção. O socket do Baileys recebe as respostas do WhatsApp e libera o próximo passo.

## Requisitos

- Windows 10/11 de 64 bits ou macOS compatível com o pacote oficial atual do Node.js.
- Internet para instalar dependências e conectar ao WhatsApp.
- Permissão para instalar o Node.js quando ele ainda não estiver disponível.
- Node.js 22 ou superior. Node.js 24 LTS é a versão recomendada e instalada pelos bootstraps.
- Uma conta de WhatsApp autorizada e um celular disponível para ler o QR Code.

Não é necessário instalar Node.js antes de executar os scripts do projeto: o bootstrap usa PowerShell no Windows e Bash no macOS, pois `node`, `npm` e `npx` não existem antes da instalação do runtime.

## Detalhes da instalação (consulta)

Para instalar sem ler os detalhes técnicos, use os blocos de **Primeira instalação** no começo deste README. Esta seção explica o que os instaladores fazem. O pacote baixado precisa conter `package.json` e `package-lock.json`.

### Windows

No PowerShell:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1
```

O `ExecutionPolicy Bypass` vale somente para esse processo; o script não altera a política global do Windows.

O instalador:

1. pede confirmação;
2. aceita uma instalação existente de Node.js >=22 com npm;
3. quando necessário, consulta o manifesto oficial da linha Node 24;
4. tenta instalar a versão exata com WinGet;
5. se WinGet não existir ou falhar, oferece o MSI oficial como alternativa;
6. compara o SHA-256 e valida a assinatura Authenticode da OpenJS antes de abrir o MSI;
7. executa `npm ci`, `npm test` e `npm run setup`.

O Windows pode mostrar UAC. O script nunca desativa a verificação de hash e não faz instalação silenciosa. Se o terminal não reconhecer o Node logo após o MSI, feche-o, abra outro PowerShell e execute o mesmo comando novamente.

### macOS

No Terminal:

```bash
/bin/bash ./scripts/install.sh
```

O instalador:

1. pede confirmação;
2. aceita uma instalação existente de Node.js >=22 com npm;
3. quando necessário, baixa o `.pkg` oficial da linha Node 24 diretamente de `nodejs.org`;
4. compara o SHA-256 publicado e valida a assinatura Node.js/OpenJS com o macOS;
5. solicita a senha pelo `sudo` apenas para executar o instalador oficial;
6. executa `npm ci`, `npm test` e `npm run setup`.

O script não instala Homebrew nem ferramentas de compilação. Se a assinatura não for reconhecida, ele interrompe o processo em vez de executar o pacote.

### Instalação manual

Se Node.js >=22 e npm já estiverem configurados:

```bash
npm ci
npm test
npm run setup
```

Use `npm ci`, não `npm install`, para reproduzir exatamente o `package-lock.json` publicado.

## Primeira configuração e QR Code

O bootstrap termina no assistente. Para executá-lo novamente:

```bash
npm run setup
```

O assistente:

1. mostra o aviso sobre a integração não oficial;
2. solicita o número **da conversa a monitorar**, com DDI e DDD, somente dígitos — por exemplo, `5511999999999`;
3. cria `config.json` no diretório privado do usuário a partir da configuração padrão;
4. cria um token aleatório para o webhook nesse mesmo diretório privado;
5. pergunta se deve iniciar o bot imediatamente;
6. mostra o QR Code no terminal quando uma nova autenticação é necessária.

No celular, abra **WhatsApp > Dispositivos conectados > Conectar um dispositivo** e leia o QR. A sessão será gravada na área privada da conta do sistema operacional. Não envie esse diretório a ninguém.

Depois da primeira configuração, inicie normalmente com:

```bash
npm start
```

Mantenha o terminal aberto. Use `Ctrl+C` para encerrar de forma controlada. Apenas uma instância pode rodar por diretório local.

## Comandos operacionais

Execute os comandos com o bot parado, salvo quando a seção indicar o contrário.

| Objetivo | Comando | Comportamento |
| --- | --- | --- |
| Iniciar | `npm start` | Abre webhook e WhatsApp; reutiliza a sessão local quando possível |
| Configuração inicial | `npm run setup` | Configura número, token e oferece QR |
| Alterar número | `npm run config:number` | Pergunta o novo número |
| Alterar número diretamente | `npm run config:number -- 5511999999999` | Valida e pede confirmação |
| Reconectar | `npm run reconnect` | Reutiliza credenciais ou oferece novo QR |
| Excluir conexão | `npm run connection:delete` | Tenta logout remoto e apaga somente a autenticação privada |
| Mostrar token | `npm run token:show` | Exibe o segredo do webhook no terminal |
| Diagnóstico | `npm run doctor` | Valida Node, configuração, bind local, token e autenticação |
| Estado local | `npm run status` | Mostra PID, número mascarado, autenticação, token e contagens |
| Listar trabalhos | `npm run jobs` | Exibe IDs, estados e passos sem nomes/PNRs |
| Testes | `npm test` | Executa a suíte automatizada |

### Alterar o número monitorado

Pare o bot com `Ctrl+C` e execute:

```bash
npm run config:number
```

Ou informe o número como argumento:

```bash
npm run config:number -- 5511999999999
```

O número deve conter de 8 a 15 dígitos, incluindo DDI. A autenticação da conta conectada é preservada. Se houver trabalhos não concluídos, o comando exige que o operador digite `CANCELAR`; isso evita misturar a fila anterior com outra conversa.

O número monitorado é o único destino usado pelo bot. O webhook não pode escolher um destinatário diferente.

### Reconectar ou forçar um novo QR

Pare o bot e execute:

```bash
npm run reconnect
```

Se uma autenticação local existir, o comando pergunta se deve apagá-la. Responda `n` para apenas tentar a reconexão. Para forçar um QR, confirme a opção e digite exatamente `NOVO QR`; o comando tenta desvincular a sessão atual antes de apagar as credenciais locais. Se a desvinculação não puder ser confirmada, confira **WhatsApp > Dispositivos conectados** no celular.

O comando inicia o bot e permanece em primeiro plano.

### Excluir a conexão do WhatsApp

Pare o bot e execute:

```bash
npm run connection:delete
```

Digite `EXCLUIR` quando solicitado. O comando mostra o caminho exato, tenta desvincular a sessão no WhatsApp por até 15 segundos e remove somente a subpasta `auth` gerenciada pelo aplicativo. O número configurado, fluxo, token e trabalhos são preservados.

Se o logout remoto não puder ser confirmado, remova o computador manualmente em **WhatsApp > Dispositivos conectados**.

## Editar mensagens e o workflow

As preferências do usuário ficam no arquivo `config.json` do diretório privado:

| Sistema | Arquivo ativo |
| --- | --- |
| Windows | `%LOCALAPPDATA%\latam-name-correction-bot\config.json` |
| macOS | `~/Library/Application Support/latam-name-correction-bot/config.json` |

O comando `npm run status` mostra o caminho exato usado nesta máquina.

Pare o bot antes de editar. O arquivo é JSON puro e não aceita comentários. Depois de salvar, valide e reinicie:

```bash
npm run doctor
npm start
```

Para uma alteração pessoal, edite o `config.json` privado, não `config/default.json`: o primeiro pertence apenas ao usuário; o segundo é o padrão público do projeto.

### Sequência padrão

| Passo | Quando é liberado | Ação |
| --- | --- | --- |
| `hello` | Trabalho criado e WhatsApp conectado | Envia `Olá` |
| `reason` | Primeira resposta nova | Envia o motivo da correção |
| `pnr` | Próxima resposta | Envia `{{pnr}}` |
| `current_name` | Próxima resposta | Envia `{{currentName}}` |
| `correct_name` | Próxima resposta | Envia `{{correctName}}` |
| `confirmation` | Próxima resposta | Envia `SIM` |
| `ticket_pdf` | Próxima resposta | Envia o PDF |
| `final_confirmation` | Próxima resposta depois do PDF | Conclui o trabalho |

Cada mensagem recebida libera no máximo um passo. O fluxo inicial usa `any_inbound`, isto é, qualquer mensagem nova elegível do número monitorado libera o passo atual. Se o menu da LATAM mudar, isso pode avançar fora de contexto. Depois de observar as respostas reais, prefira `contains` ou `regex` com padrões específicos.

### Estrutura de um passo

Mensagem fixa:

```json
{
  "id": "reason",
  "await": {
    "mode": "any_inbound"
  },
  "send": {
    "kind": "text",
    "value": "Preciso corrigir uma letra de um nome na reserva"
  }
}
```

Matcher mais específico:

```json
{
  "id": "pnr",
  "await": {
    "mode": "regex",
    "anyOf": [
      "informe.*(pnr|localizador)",
      "qual.*(pnr|localizador)"
    ]
  },
  "send": {
    "kind": "text",
    "value": "{{pnr}}"
  }
}
```

Regras aceitas:

- `await.mode`: `job_created`, `any_inbound`, `contains` ou `regex`;
- o primeiro passo deve usar `job_created`, e nenhum outro pode usá-lo;
- `contains` e `regex` precisam de `await.anyOf` com pelo menos um texto;
- regex são limitadas a 500 caracteres e precisam passar pela validação de segurança do `safe-regex2`;
- `send.kind`: `text` ou `document`;
- variáveis permitidas nos templates: `{{pnr}}`, `{{currentName}}`, `{{correctName}}` e `{{ticketFileName}}`;
- documentos devem usar `"sourceField": "ticketPdf"` e definir `fileName`;
- IDs devem ser únicos, começar por letra, ter de 2 a 50 caracteres e usar apenas minúsculas, números, `_` ou `-`;
- o último passo deve ser o único terminal: `"terminal": "success"`;
- `stepTimeoutMinutes` aceita 1–1440 minutos e `jobTimeoutMinutes`, 1–10080;
- `maxUploadMb` aceita 1–100 MB e `retentionDays`, 0–3650 dias.

Uma configuração é carregada ao iniciar o processo. Cada trabalho também guarda um snapshot do workflow com o qual foi criado. Portanto, alterações valem para **novos trabalhos após reiniciar o bot**; trabalhos já existentes continuam com a sequência anterior.

Uma descrição mais detalhada está em [docs/FLUXO.md](docs/FLUXO.md).

## Webhook local

Por padrão, o servidor escuta somente em:

```text
http://127.0.0.1:3000
```

Obtenha o token com:

```bash
npm run token:show
```

Trate o valor como senha. Todas as rotas de trabalho exigem:

```http
Authorization: Bearer SEU_TOKEN
```

### Rotas

| Método e rota | Autenticação | Uso |
| --- | --- | --- |
| `GET /health` | Não | Estado mínimo do processo e conexão |
| `POST /api/jobs` | Bearer | Cria um trabalho |
| `POST /webhooks/name-correction` | Bearer | Alias de criação de trabalho |
| `GET /api/jobs` | Bearer | Lista trabalhos sem payload pessoal |
| `GET /api/jobs/:id` | Bearer | Consulta um trabalho |
| `POST /api/jobs/:id/actions` | Bearer | Recupera, cancela ou resolve envio incerto |

Um trabalho novo normalmente retorna HTTP `202`. Repetir a mesma chave de idempotência retorna HTTP `200`, `created: false` e o trabalho já existente.

### Campos de criação

| Campo | Obrigatório | Regra |
| --- | --- | --- |
| `pnr` | Sim | Exatamente 6 letras/números; convertido para maiúsculas |
| `currentName` | Sim | 1–100 caracteres de nome permitidos |
| `correctName` | Sim | 1–100 caracteres de nome permitidos |
| `ticket` | Sim, em multipart | PDF válido enviado como arquivo |
| `ticketPdfBase64` | Sim, em JSON | PDF em Base64, com ou sem prefixo `data:application/pdf;base64,` |
| `ticketFileName` | Não | Nome terminado em `.pdf`; padrão `bilhete-PNR.pdf` |
| `requestId` | Não | Alternativa à chave no header |

Envie também `Idempotency-Key`, com 8–128 caracteres usando letras, números, `.`, `_`, `:`, ou `-`. Reutilize a mesma chave ao repetir uma requisição cujo resultado ficou incerto.

O PDF precisa começar com a assinatura `%PDF-`. O limite padrão é 16 MB. A rota reserva espaço para a expansão de aproximadamente 33% do Base64, mas esse formato consome mais memória; prefira multipart para arquivos maiores.

### Exemplo curl — multipart

macOS/Linux ou Git Bash:

```bash
TOKEN="$(npm run --silent token:show)"

curl --fail-with-body \
  --request POST 'http://127.0.0.1:3000/api/jobs' \
  --header "Authorization: Bearer ${TOKEN}" \
  --header 'Idempotency-Key: corr-QWEBZI-20260711-001' \
  --form 'pnr=QWEBZI' \
  --form 'currentName=JANDELA' \
  --form 'correctName=DANIELA' \
  --form 'ticket=@/caminho/bilhete.pdf;type=application/pdf'
```

No Windows PowerShell também é possível usar `curl.exe` com os mesmos headers e opções `--form`.

### Exemplo PowerShell 7 — multipart

```powershell
$token = ((npm run --silent token:show) | Select-Object -Last 1).Trim()
$headers = @{
    Authorization = "Bearer $token"
    'Idempotency-Key' = 'corr-QWEBZI-20260711-002'
}
$form = @{
    pnr = 'QWEBZI'
    currentName = 'JANDELA'
    correctName = 'DANIELA'
    ticket = (Get-Item -LiteralPath 'C:\Bilhetes\bilhete.pdf')
}

$request = @{
    Method = 'Post'
    Uri = 'http://127.0.0.1:3000/api/jobs'
    Headers = $headers
    Form = $form
}
Invoke-RestMethod @request
```

O parâmetro `-Form` requer PowerShell 7. No Windows PowerShell 5.1, use `curl.exe` para multipart ou o exemplo JSON abaixo.

### Exemplo curl — JSON com PDF em Base64

Recomendado apenas para PDFs pequenos:

```bash
TOKEN="$(npm run --silent token:show)"
PDF_BASE64="$(base64 < '/caminho/bilhete.pdf' | tr -d '\r\n')"

curl --fail-with-body \
  --request POST 'http://127.0.0.1:3000/webhooks/name-correction' \
  --header "Authorization: Bearer ${TOKEN}" \
  --header 'Idempotency-Key: corr-QWEBZI-20260711-003' \
  --header 'Content-Type: application/json' \
  --data-binary @- <<JSON
{
  "pnr": "QWEBZI",
  "currentName": "JANDELA",
  "correctName": "DANIELA",
  "ticketFileName": "bilhete-QWEBZI.pdf",
  "ticketPdfBase64": "${PDF_BASE64}"
}
JSON

unset PDF_BASE64
```

### Exemplo PowerShell — JSON com PDF em Base64

Compatível com Windows PowerShell 5.1 e PowerShell 7:

```powershell
$token = ((npm run --silent token:show) | Select-Object -Last 1).Trim()
$pdfPath = 'C:\Bilhetes\bilhete.pdf'
$body = @{
    pnr = 'QWEBZI'
    currentName = 'JANDELA'
    correctName = 'DANIELA'
    ticketFileName = [IO.Path]::GetFileName($pdfPath)
    ticketPdfBase64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($pdfPath))
} | ConvertTo-Json -Compress

$request = @{
    Method = 'Post'
    Uri = 'http://127.0.0.1:3000/webhooks/name-correction'
    Headers = @{
        Authorization = "Bearer $token"
        'Idempotency-Key' = 'corr-QWEBZI-20260711-004'
    }
    ContentType = 'application/json'
    Body = $body
}
Invoke-RestMethod @request
```

### Consultar fila e saúde

```bash
TOKEN="$(npm run --silent token:show)"

curl 'http://127.0.0.1:3000/health'
curl --header "Authorization: Bearer ${TOKEN}" \
  'http://127.0.0.1:3000/api/jobs'
```

## Estados e recuperação

O bot processa somente um trabalho ativo por conversa. Os seguintes permanecem em `queued` até o anterior ser concluído, cancelado ou resolvido.

| Estado | Significado | Ação típica |
| --- | --- | --- |
| `queued` | Aguardando conexão ou sua vez na fila | Aguarde; não duplique a requisição |
| `sending` | Envio em andamento | Não interrompa o processo intencionalmente |
| `waiting` | Aguardando resposta do número monitorado | Confira a conversa e o matcher atual |
| `timed_out` | Passo ou trabalho excedeu o tempo | Revise e use `resume-waiting` ou `cancel` |
| `send_uncertain` | Não foi possível provar se o envio ocorreu | Revise o WhatsApp antes de escolher uma ação |
| `failed` | O snapshot do trabalho não pôde iniciar | Investigue a configuração e cancele; não há retomada automática |
| `manual_intervention` | Foi detectada mensagem própria que não pertence ao bot | Revise a conversa e use `resume-waiting` ou `cancel` |
| `completed` | Houve resposta posterior ao PDF | Terminal; será removido após a retenção |
| `cancelled` | Cancelado pelo operador | Terminal; será removido após a retenção |

Uma queda durante `sending` é recuperada como `send_uncertain`. O bot não repete automaticamente PNR, nomes, confirmação ou PDF. Uma mensagem enviada manualmente pela conta conectada, na mesma conversa e durante um trabalho ativo, gera `manual_intervention`; mensagens cujo ID foi registrado como envio do próprio bot não causam essa pausa. Ao desconectar enquanto espera, o timeout do passo é reagendado na reconexão; o limite total do trabalho continua baseado na criação e pode vencer após uma desconexão longa.

Liste os trabalhos:

```bash
npm run jobs
```

Resolva pelo CLI, com o bot e webhook em execução:

```bash
node src/cli.js job-action ID_DO_TRABALHO resume-waiting
node src/cli.js job-action ID_DO_TRABALHO cancel
node src/cli.js job-action ID_DO_TRABALHO retry-send
node src/cli.js job-action ID_DO_TRABALHO assume-sent
```

Regras:

- `cancel`: cancela qualquer trabalho não terminal;
- `resume-waiting`: somente para `timed_out` ou `manual_intervention`;
- `retry-send`: somente para `send_uncertain`; pode duplicar uma mensagem já entregue;
- `assume-sent`: somente para `send_uncertain`; considera o passo entregue e passa a aguardar a próxima resposta.

Antes de `retry-send` ou `assume-sent`, abra o WhatsApp e confira o que realmente aparece na conversa.

Também é possível usar HTTP:

```bash
curl --request POST \
  --url "http://127.0.0.1:3000/api/jobs/ID_DO_TRABALHO/actions" \
  --header "Authorization: Bearer ${TOKEN}" \
  --header 'Content-Type: application/json' \
  --data '{"action":"resume-waiting"}'
```

## Dados locais, privacidade e Git

Por padrão, todo estado privado fica fora do projeto, em uma pasta exclusiva da conta do sistema operacional:

- Windows: `%LOCALAPPDATA%\latam-name-correction-bot`
- macOS: `~/Library/Application Support/latam-name-correction-bot`

O aplicativo aplica permissões restritas (`ACL` no Windows e modo `0700` no macOS) e cria um marcador de segurança antes de permitir qualquer exclusão.

| Caminho | Conteúdo |
| --- | --- |
| `auth/` | Credenciais de longa duração do WhatsApp |
| `config.json` | Número monitorado e workflow pessoal |
| `webhook-token` | Token Bearer de 64 caracteres hexadecimais |
| `jobs.json` | PNRs, nomes, fila, estados e ledger de deduplicação |
| `uploads/` | PDFs recebidos pelo webhook |
| `bot.pid` | Bloqueio da instância em execução |
| `.latam-name-bot-data` | Marcador que impede exclusão em pasta não gerenciada |

Como o diretório padrão fica fora do repositório, esses dados não entram no Git. O `.gitignore` também exclui `.local/*`, `.env*`, logs, dependências e configurações alternativas como uma segunda proteção para o modo portátil.

Antes de publicar:

```bash
git status --short --ignored
git check-ignore .local/config.json .local/webhook-token .local/auth/creds.json
```

Se `.local/` já entrou no histórico ou no índice, remova-o do rastreamento e considere todas as credenciais comprometidas:

```bash
git rm --cached -r .local
```

Depois, desvincule a sessão, gere outro QR e rotacione o token conforme [SECURITY.md](SECURITY.md). Apagar apenas o arquivo do commit atual não remove o conteúdo do histórico Git.

Outras recomendações:

- não envie QR, diretório privado, PDF, token ou logs completos em issues e chats;
- não sincronize o diretório privado em pastas públicas; criptografe backups;
- mantenha `server.host` em `127.0.0.1`;
- se expuser a API, use firewall, TLS, proxy autenticado e rotação de token;
- obtenha base legal para processar nomes, PNRs e bilhetes;
- o projeto não implementa telemetria central; dados saem da máquina apenas conforme necessário para a conexão e os envios pelo WhatsApp;
- a retenção remove periodicamente trabalhos `completed`/`cancelled`, PDFs antigos e entradas vencidas do ledger; não remove autenticação nem token.

É possível mover o diretório privado definindo `LATAM_BOT_LOCAL_DIR` com um caminho absoluto. O destino deve ficar fora do projeto; a única exceção é a pasta `.local` do próprio projeto, já coberta pelo `.gitignore`. Use o mesmo valor em todos os comandos.

## Solução de problemas

Comece por:

```bash
npm run doctor
npm run status
node --version
npm --version
```

### `package-lock.json não foi encontrado`

O bootstrap exige o lockfile. Baixe novamente a release/ZIP completa ou restaure o arquivo do repositório. Não substitua automaticamente `npm ci` por `npm install`, pois isso altera a resolução das dependências.

### Node foi instalado, mas não é reconhecido

Feche o terminal, abra outro na pasta do projeto e execute novamente `scripts/install.ps1` ou `scripts/install.sh`. No Windows, confira também `C:\Program Files\nodejs` no `PATH`.

### PowerShell bloqueou o script

Use o comando documentado com `-ExecutionPolicy Bypass`, que vale apenas para aquela execução. Não defina `Unrestricted` globalmente.

### WinGet não existe ou falhou

O instalador oferece o MSI oficial verificado. Se ambos falharem, confira internet, proxy, relógio do sistema, política corporativa e permissões administrativas. Nunca desative a validação de assinatura para contornar o erro.

### O QR Code não aparece

- Pode existir uma sessão válida no diretório privado; nesse caso nenhum QR é necessário.
- Rode `npm run reconnect` e escolha forçar `NOVO QR` se quiser substituir a sessão.
- Confirme internet no computador e no celular.
- Aumente a janela do terminal para que o QR não seja quebrado.

### O bot informa que já está em execução

Use `npm run status`, encontre o outro terminal/processo e encerre-o com `Ctrl+C`. Um lock de processo morto é limpo automaticamente na próxima inicialização; não apague arquivos enquanto outra instância estiver ativa.

### Porta 3000 em uso

Pare o outro serviço ou altere `server.port` no `config.json` privado mostrado por `npm run status`, rode `npm run doctor` e reinicie. Atualize também as URLs dos clientes.

### Webhook retorna 401

Obtenha novamente o token com `npm run token:show` e envie exatamente `Authorization: Bearer TOKEN`. Não inclua aspas, espaços extras ou o token de outra pasta local.

### Webhook retorna 400 ou 413

- confirme PNR com exatamente seis letras/números;
- use `ticket` no multipart ou `ticketPdfBase64` no JSON;
- confirme que o arquivo começa com `%PDF-` e termina em `.pdf`;
- reduza o arquivo ou revise `server.maxUploadMb`;
- lembre que Base64 aumenta o corpo; prefira multipart.

### A primeira mensagem não foi enviada

Consulte `/health` e `npm run jobs`. Quando o WhatsApp está desconectado, o trabalho permanece `queued` e o `Olá` é enviado depois da conexão. Não crie outro trabalho: repita a mesma `Idempotency-Key` para consultar o resultado existente.

### Respostas não avançam o fluxo

- confira se o trabalho está em `waiting`;
- confirme o número exato em `npm run status`;
- somente mensagens novas do número monitorado são elegíveis;
- grupos, histórico sincronizado, reações e recibos são ignorados;
- envios conhecidos do próprio bot não avançam o fluxo; uma mensagem manual desconhecida da conta conectada pausa em `manual_intervention`;
- se o matcher for `contains`/`regex`, revise o `config.json` privado mostrado por `npm run status`.

### Trabalho em `send_uncertain`

Não reinicie nem reenvie cegamente. Abra a conversa, confira se o passo aparece e use `retry-send`, `assume-sent` ou `cancel` conforme a evidência.

### Configuração inválida

JSON não aceita comentários nem vírgula depois do último item. Compare com `config/default.json`, corrija o campo informado por `npm run doctor` e reinicie.

## Desenvolvimento e contribuições

Antes de enviar uma alteração:

```bash
npm ci
npm test
```

Não inclua diretórios privados, `.local/`, dumps de conversa, PDFs ou credenciais em fixtures. Use dados claramente fictícios. Alterações de dependências devem atualizar e revisar `package-lock.json`.

Falhas de segurança devem seguir [SECURITY.md](SECURITY.md), não uma issue pública com detalhes sensíveis.

## Fontes oficiais e documentação upstream

- [Download oficial do Node.js](https://nodejs.org/en/download)
- [Ciclo e versões LTS do Node.js](https://nodejs.org/en/about/previous-releases)
- [Verificação oficial dos binários do Node.js](https://github.com/nodejs/node#verifying-binaries)
- [Microsoft WinGet](https://learn.microsoft.com/en-us/windows/package-manager/winget/)
- [Opções do `winget install`](https://learn.microsoft.com/en-us/windows/package-manager/winget/install)
- [Baileys — conexão](https://baileys.wiki/docs/socket/connecting/)
- [Baileys — recebimento de eventos e `messages.upsert`](https://baileys.wiki/docs/socket/receiving-updates/)
- [Política de segurança do Baileys](https://github.com/WhiskeySockets/Baileys/security)
- [Termos do WhatsApp](https://www.whatsapp.com/legal/terms-of-service)

## Licença

Distribuído sob a [licença MIT](LICENSE). Marcas e nomes de terceiros pertencem aos seus respectivos titulares.

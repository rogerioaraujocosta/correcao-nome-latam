# Fluxo de correção de nome LATAM

O arquivo `config/default.json` é o modelo público da conversa. Após o assistente inicial, a configuração ativa e editável fica no diretório privado do usuário (`%LOCALAPPDATA%\latam-name-correction-bot` no Windows ou `~/Library/Application Support/latam-name-correction-bot` no macOS). Ela reproduz a sequência mostrada no fluxo atual: `Olá`, motivo do contato, PNR, nome atual, nome correto, `SIM`, PDF do bilhete e espera pela confirmação final da LATAM.

## Como a conversa começa

Há dois tipos de evento, com responsabilidades diferentes:

1. O webhook local cria um trabalho com os dados da correção e o PDF. A criação libera imediatamente o passo `hello`.
2. O socket do Baileys recebe as mensagens do WhatsApp. Somente mensagens novas do número configurado em `whatsapp.monitoredNumber` podem liberar os passos seguintes.

O QR Code apenas autentica a conexão do WhatsApp; ele não cria um webhook. O servidor HTTP local recebe o trabalho, enquanto os eventos do socket conduzem a conversa.

O campo `monitoredNumber` começa vazio intencionalmente. A instalação deve solicitar o número ao usuário antes de iniciar o bot. O valor deve usar apenas dígitos, com código do país e DDD, por exemplo `5511999999999`.

## Variáveis do trabalho

Cada trabalho precisa fornecer estes campos:

| Campo | Uso | Validação recomendada |
| --- | --- | --- |
| `pnr` | Conteúdo do passo `pnr` e nome do PDF | Obrigatório; inicialmente seis letras ou números (`^[A-Z0-9]{6}$`) |
| `currentName` | Nome que consta atualmente no bilhete | Obrigatório; remover espaços externos sem modificar silenciosamente o conteúdo |
| `correctName` | Nome correto que será solicitado | Obrigatório; remover espaços externos sem modificar silenciosamente o conteúdo |
| `ticketPdf` | Arquivo enviado no passo `ticket_pdf` | Obrigatório enquanto o workflow contiver um passo `document`; assinatura `%PDF-` e tamanho são validados |

As expressões `{{pnr}}`, `{{currentName}}` e `{{correctName}}` são substituídas no momento do envio. `ticketPdf` é referenciado por `sourceField`, não é interpolado como texto. Templates devem aceitar somente os campos permitidos; a configuração nunca deve executar JavaScript, comandos ou caminhos arbitrários.

## Sequência configurada

| Passo | Evento aguardado | Ação |
| --- | --- | --- |
| `hello` | Criação do trabalho (`job_created`) | Envia `Olá` |
| `reason` | A mensagem da LATAM que começa com “Perfeito! Vou ajudá-lo...” e solicita validação de identidade | Envia `Preciso corrigir uma letra de um nome na reserva` |
| `pnr` | Próxima resposta nova | Envia `{{pnr}}` |
| `current_name` | Próxima resposta nova | Envia `{{currentName}}` |
| `correct_name` | Próxima resposta nova | Envia `{{correctName}}` |
| `confirmation` | Próxima resposta nova | Envia `SIM` |
| `ticket_pdf` | Próxima resposta nova | Envia o arquivo indicado por `ticketPdf` |
| `final_confirmation` | Próxima resposta nova | Encerra o trabalho com sucesso |

A regra global `infant_agent_handoff` é avaliada em qualquer passo. Se uma mensagem contiver simultaneamente “Esta reserva inclui um passageiro menor de 2 anos (bebê)” e “Gostaria que eu conecte você com um agente especializado”, o bot envia `Sim` e conclui imediatamente o trabalho. PNR, nome e demais campos da mensagem não participam da correspondência e podem variar.

Cada mensagem recebida pode liberar no máximo um passo. Mesmo que um texto corresponda a mais de um matcher, o engine deve consumir o evento apenas no passo atual.

## Estados

O fluxo conceitual é:

```text
QUEUED
  -> VALIDATING
  -> SENDING_HELLO
  -> WAITING_REASON
  -> SENDING_REASON
  -> WAITING_PNR
  -> SENDING_PNR
  -> WAITING_CURRENT_NAME
  -> SENDING_CURRENT_NAME
  -> WAITING_CORRECT_NAME
  -> SENDING_CORRECT_NAME
  -> WAITING_CONFIRMATION
  -> SENDING_CONFIRMATION
  -> WAITING_TICKET_PDF_REQUEST
  -> SENDING_TICKET_PDF
  -> WAITING_FINAL_CONFIRMATION
  -> COMPLETED
```

Os estados persistidos laterais são `manual_intervention`, `timed_out`, `send_uncertain`, `failed` e `cancelled`. Durante uma desconexão, o trabalho permanece em `waiting`, mas o temporizador do passo é suspenso e reagendado ao reconectar.

- Ao desconectar, o bot pausa a contagem do passo e não repete a última mensagem depois de reconectar.
- Se o processo cair sem conseguir determinar se um envio ocorreu, deve usar `SEND_UNCERTAIN`; repetir automaticamente PNR, nomes, `SIM` ou PDF pode desalinhar a conversa.
- Uma mensagem manual enviada pelo usuário no mesmo chat durante um trabalho deve pausá-lo para revisão.
- `COMPLETED` só é alcançado depois de uma mensagem posterior ao PDF, não apenas pelo aceite local do upload.

## Matchers

O schema admite estes modos de espera:

- `job_created`: usado somente no primeiro passo; não depende de mensagem recebida.
- `any_inbound`: aceita qualquer mensagem elegível do número monitorado.
- `contains`: aceita quando o texto normalizado contém um dos valores de `anyOf`.
- `regex`: aceita quando o texto normalizado corresponde a uma das expressões de `anyOf`.

O fluxo inicial usa `any_inbound` porque o print informa apenas as mensagens enviadas e não mostra os textos das respostas da LATAM. Essa estratégia atende à instrução de aguardar uma resposta antes de enviar a próxima mensagem, mas exige cautela: indisponibilidade, transferência para atendente ou mudança de menu também podem parecer uma resposta válida.

Depois de observar as respostas reais, substitua cada `any_inbound` por `contains` ou `regex`. Exemplo ilustrativo, que só deve ser adotado após conferir o texto verdadeiro:

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

Antes de comparar, o engine limita o texto a 4096 caracteres e normaliza Unicode, caixa, espaços e acentos. Expressões inválidas, maiores que 500 caracteres ou classificadas como inseguras por `safe-regex2` fazem a configuração falhar antes do bot iniciar.

## Correlação, fila e deduplicação

Uma mensagem recebida só pode avançar o trabalho quando todas estas condições forem verdadeiras:

1. Pertence à conexão atual e ao número monitorado, após normalização do JID.
2. Não é `fromMe`, status, grupo, newsletter, reação, recibo ou mensagem de protocolo.
3. Existe um trabalho ativo para essa conversa e ele está aguardando o passo atual.
4. A mensagem chegou depois da entrada nesse estado de espera.
5. Seu identificador ainda não foi consumido.
6. Seu conteúdo atende ao matcher do passo atual.

Deve existir no máximo um trabalho ativo por combinação de conexão e número monitorado. Trabalhos adicionais permanecem em fila. Isso é necessário porque a conversa do WhatsApp não fornece um identificador de correção confiável para separar dois PNRs simultâneos.

Como há uma única conexão local, o ledger persistente usa `{targetNumber, messageId}` como chave global, atravessando trabalhos e reinícios. Cada trabalho mantém também sua lista curta de IDs consumidos. O webhook usa uma chave de idempotência própria. Eventos de sincronização de histórico não liberam etapas; o transporte registra o timestamp remoto quando disponível e carimba todas as mensagens de um mesmo lote com o mesmo instante local, impedindo que duas mensagens do lote avancem dois passos.

## Timeouts, reconexão e retenção

- `workflow.stepTimeoutMinutes` limita a espera por cada resposta.
- `workflow.jobTimeoutMinutes` limita a duração total da correção.
- Um trabalho que vencer ainda na fila é pausado antes de enviar `Olá`.
- Timeout deve pausar ou encerrar para revisão, nunca liberar o passo seguinte.
- `whatsapp.reconnect.maxAttempts: 0` significa tentativas ilimitadas, com atraso exponencial limitado por `maxDelayMs`.
- `storage.retentionDays` controla somente dados operacionais concluídos e chaves de deduplicação. Não deve apagar a autenticação ativa do WhatsApp.

Não faça reenvio automático de passos após timeout ou reconexão. O Baileys não oferece garantia de entrega exatamente uma vez, portanto um resultado incerto precisa de revisão humana.

## Edição segura do fluxo

- Para mudar uma mensagem fixa, altere somente `send.value`.
- Para mudar a ordem, reordene objetos completos em `workflow.steps`.
- Para adicionar um passo, use um `id` único e defina `await` e, quando aplicável, `send`.
- O primeiro passo precisa usar `job_created`.
- Deve haver apenas um passo terminal, colocado depois do envio do PDF.
- `sourceField` deve apontar para um campo de arquivo permitido pelo servidor.
- O arquivo é JSON puro e não aceita comentários.

Valide a configuração inteira antes de abrir a conexão do WhatsApp. Uma alteração deve valer apenas para trabalhos novos; cada trabalho ativo preserva uma cópia da versão do fluxo com a qual começou. A troca do número monitorado exige o cancelamento explícito dos trabalhos pendentes. Antes de cada envio, o engine também compara o número do snapshot, da configuração ativa e do transporte; qualquer divergência bloqueia o envio.

## Cautelas operacionais e de privacidade

- O destino da mensagem sempre vem de `whatsapp.monitoredNumber`; o webhook não pode escolher outro número.
- Mantenha o servidor em `127.0.0.1` por padrão. Se houver exposição externa, exija TLS e autenticação forte.
- PNR, nomes, PDFs, tokens, banco local e credenciais do WhatsApp não podem ser versionados no Git.
- Mascarar PNR e nomes nos logs reduz a exposição de dados pessoais.
- Validar assinatura e tamanho do PDF; não aceitar caminho arbitrário informado por requisição remota. O MIME declarado pelo cliente não é tratado como prova.
- O número deve ser comparado pelo JID canônico. Um alias LID só pode ser aceito depois de resolvido e associado ao mesmo número pela própria conexão.
- Mudanças no menu da LATAM devem fazer o fluxo parar com segurança, não continuar enviando dados fora de contexto.

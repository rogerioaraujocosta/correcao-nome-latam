# Política de segurança

Este projeto processa credenciais de WhatsApp e dados pessoais de viagem. Trate qualquer falha que permita ler, substituir, enviar, versionar ou expor esses dados como potencialmente grave.

## Versões suportadas

Por ser um projeto pequeno e dependente de um protocolo externo que muda com frequência, apenas a versão mais recente publicada recebe correções de segurança.

| Versão | Suporte |
| --- | --- |
| Release mais recente | Sim |
| Releases anteriores | Não, salvo anúncio explícito |
| Forks e alterações locais | Responsabilidade do mantenedor do fork |

Antes de reportar, reproduza na versão mais recente sem anexar credenciais reais.

## Como reportar uma vulnerabilidade

Use **GitHub Security Advisories > Report a vulnerability** neste repositório. Esse é o canal preferido porque mantém descrição, anexos e discussão privados.

Inclua, quando possível:

- versão/tag ou commit afetado;
- sistema operacional e versão do Node.js;
- componente afetado;
- pré-condições e impacto;
- passos mínimos de reprodução com dados fictícios;
- correção sugerida, se houver;
- indicação de exploração ativa, caso exista.

Não inclua autenticação do Baileys, QR Code, token do webhook, PNR, nome real, PDF, número completo ou dump de conversa. Se o recurso privado do GitHub não estiver disponível, abra apenas uma issue pedindo um canal privado, sem revelar detalhes técnicos.

Os mantenedores analisarão o relato em melhor esforço, coordenarão a correção e publicarão crédito se o pesquisador desejar. Não há SLA garantido.

## O que está no escopo

Exemplos de problemas de segurança deste projeto:

- bypass ou comparação insegura do Bearer token;
- acesso ao webhook protegido sem autorização;
- exposição do diretório privado, credenciais, token, PDFs ou `jobs.json`;
- envio para um número diferente do monitorado;
- mistura de trabalhos ou mensagens entre conversas;
- travessia de diretório, escrita/leitura fora da área privada gerenciada;
- execução de código ou comandos a partir da configuração, templates ou upload;
- validação de PDF contornável com impacto de segurança;
- reenvio automático capaz de expor PNR, nomes ou bilhetes fora de contexto;
- logs ou respostas HTTP que revelem dados pessoais/segredos;
- vulnerabilidade em dependência alcançável pelo uso normal do projeto.

## O que não está no escopo

- indisponibilidade ou mudança do WhatsApp/LATAM sem falha explorável no projeto;
- bloqueio de conta decorrente do uso de uma integração não oficial;
- alterações de menu que exijam atualizar matchers;
- spam, engenharia social ou uso deliberado fora da finalidade;
- problemas exclusivos de forks não reproduzíveis na versão oficial;
- vulnerabilidades do Baileys, Node.js, WhatsApp ou outra dependência sem impacto demonstrável neste projeto.

Problemas upstream devem ser reportados ao fornecedor correspondente. Para o Baileys, siga a [política de segurança upstream](https://github.com/WhiskeySockets/Baileys/security). Não publique estado de autenticação para demonstrar uma falha.

## Material sensível

Todo o diretório de dados do usuário deve ser considerado privado. Por padrão ele fica em `%LOCALAPPDATA%\latam-name-correction-bot` no Windows e `~/Library/Application Support/latam-name-correction-bot` no macOS:

| Caminho | Sensibilidade |
| --- | --- |
| `auth/` | Credencial de longa duração; pode permitir sequestro da sessão |
| `webhook-token` | Autoriza criar, consultar e alterar trabalhos |
| `config.json` | Contém número monitorado e regras operacionais |
| `jobs.json` | Pode conter PNRs, nomes, estados, histórico e deduplicação |
| `uploads/` | Contém bilhetes em PDF |

O projeto cria o diretório com modo `0700` em sistemas POSIX e restringe a ACL no Windows ao usuário atual, `SYSTEM` e administradores. Um marcador próprio é exigido antes de excluir `auth/`, e links simbólicos/junções são recusados. Não coloque o diretório em OneDrive/Drive público, imagem Docker, artefato de CI ou backup sem criptografia.

O `.gitignore` reduz o risco, mas não protege um arquivo que já foi rastreado. Antes de publicar, confira:

```bash
git status --short --ignored
git check-ignore .local/config.json .local/webhook-token .local/auth/creds.json
```

## Resposta a incidente

### Credenciais do WhatsApp ou QR expostos

1. Pare o bot com `Ctrl+C`.
2. Execute `npm run connection:delete` e confirme `EXCLUIR`.
3. No celular, abra **WhatsApp > Dispositivos conectados** e remova o computador, mesmo que o logout local diga ter funcionado.
4. Verifique mensagens e dispositivos desconhecidos na conta.
5. Quando o ambiente estiver seguro, execute `npm run reconnect` e leia um novo QR.

Apagar apenas `auth/` impede o uso local, mas não substitui a verificação no celular.

### Token do webhook exposto

1. Pare o bot.
2. Exclua somente `webhook-token` no diretório mostrado por `npm run status`.
3. Execute `npm run setup`, preserve o número configurado e copie o novo token.
4. Atualize clientes autorizados e invalide cópias antigas.
5. Revise `jobs.json` no diretório privado para identificar requisições inesperadas sem compartilhar o arquivo.

O token é criado novamente de forma aleatória quando está ausente. `npm run token:show` apenas exibe o token atual; não faz rotação.

### Dados entraram no Git

1. Pare novas publicações e torne o repositório privado, se possível.
2. Remova do índice com `git rm --cached -r .local`.
3. Rotacione token e autenticação; considere PNRs/PDFs comprometidos.
4. Remova os dados do histórico com uma ferramenta apropriada e coordene a atualização de clones/forks.
5. Avalie obrigações de notificação e resposta conforme a LGPD e contratos aplicáveis.

Um commit posterior apagando o arquivo não o remove do histórico.

### PDF, PNR ou nomes expostos

Interrompa o acesso, preserve somente a evidência necessária, identifique o alcance e siga o processo de incidente/privacidade da organização. Não copie o material para uma issue pública.

## Operação segura

- Mantenha `server.host` em `127.0.0.1`, `::1` ou `localhost`.
- `/health` não exige token e deve permanecer sem dados pessoais.
- Todas as rotas de `/api` e o webhook de correção exigem Bearer token.
- Se a API precisar sair da máquina, use TLS, firewall, proxy autenticado, limitação de origem/taxa e rotação periódica do token.
- Não coloque o token em URL, histórico público de shell ou código-fonte.
- Use uma `Idempotency-Key` única e repita a mesma chave quando o resultado HTTP for incerto.
- Não use `retry-send` sem conferir a conversa; um envio incerto pode já ter sido entregue.
- Não altere número/workflow com o bot em execução.
- Use somente uma conta e um número de destino autorizados.
- Minimize a retenção e cancele trabalhos obsoletos para que possam ser limpos.
- Restrinja acesso físico e lógico à máquina que contém a sessão.

O bind padrão local não transforma o webhook em uma fronteira de segurança suficiente contra outros processos da mesma máquina. O token continua obrigatório.

## Instalação e cadeia de suprimentos

- Use Node.js 22+; Node.js 24 LTS é recomendado.
- O fallback direto baixa Node de `https://nodejs.org` e verifica SHA-256 e assinatura de plataforma; no Windows, o caminho preferencial delega a instalação à fonte oficial do WinGet.
- No Windows, nunca use `--ignore-security-hash` no WinGet.
- No macOS, não contorne falha de `pkgutil --check-signature`.
- Instale dependências com `npm ci` e mantenha `package-lock.json` revisado.
- Fixe versões de dependências; não dependa de branches como `master` em produção.
- Analise atualizações do Baileys antes de publicar, pois mudanças de protocolo e migrações podem alterar autenticação e filtragem de mensagens.

Fontes: [downloads e verificação do Node.js](https://github.com/nodejs/node#verifying-binaries), [WinGet](https://learn.microsoft.com/en-us/windows/package-manager/winget/) e [segurança do Baileys](https://github.com/WhiskeySockets/Baileys/security).

## Privacidade e responsabilidade do operador

O projeto não concede autorização para processar dados de passageiros. O operador é responsável por base legal, finalidade, transparência, controle de acesso, retenção, direitos dos titulares e contratos com os serviços envolvidos.

Este software usa uma integração não oficial e não é afiliado à LATAM, Meta ou WhatsApp. Leia os [Termos do WhatsApp](https://www.whatsapp.com/legal/terms-of-service) e não use o projeto para spam, mensagens em massa, vigilância ou acesso sem consentimento.

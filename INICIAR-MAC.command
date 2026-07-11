#!/bin/bash
cd "$(dirname "$0")" || exit 1
if [[ ! -f package.json ]]; then
    echo "ERRO: package.json nao foi encontrado nesta pasta."
    exit 1
fi
if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
    echo "Node.js/npm nao foi encontrado. Abrindo o instalador..."
    /bin/bash ./scripts/install.sh
    exit $?
fi
if npm run doctor >/dev/null 2>&1; then
    npm start
else
    echo "A configuracao inicial ainda nao foi concluida. Abrindo o assistente..."
    npm run setup
fi

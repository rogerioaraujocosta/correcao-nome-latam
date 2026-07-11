#!/bin/bash

set -Eeuo pipefail

REPOSITORY="https://github.com/rogerioaraujocosta/correcao-nome-latam"
ARCHIVE_URL="${REPOSITORY}/archive/refs/heads/main.zip"
DESTINATION="${HOME}/correcao-nome-latam"
DOWNLOAD_ONLY=0
TEMPORARY_DIRECTORY=""
TEMP_BASE="${TMPDIR:-/tmp}"
TEMP_BASE="${TEMP_BASE%/}"

cleanup() {
    if [[ -n "${TEMPORARY_DIRECTORY}" && -d "${TEMPORARY_DIRECTORY}" ]]; then
        case "${TEMPORARY_DIRECTORY}" in
            "${TEMP_BASE}"/correcao-nome-latam.*) rm -rf -- "${TEMPORARY_DIRECTORY}" ;;
        esac
    fi
}

trap cleanup EXIT

while [[ $# -gt 0 ]]; do
    case "$1" in
        --destination)
            [[ $# -ge 2 ]] || { echo "Falta o caminho depois de --destination." >&2; exit 1; }
            DESTINATION="$2"
            shift 2
            ;;
        --download-only)
            DOWNLOAD_ONLY=1
            shift
            ;;
        *)
            echo "Opcao desconhecida: $1" >&2
            exit 1
            ;;
    esac
done

is_project_directory() {
    [[ -f "$1/package.json" && -f "$1/scripts/install.sh" ]]
}

echo "Instalador do Bot de Correcao de Nome LATAM"
echo "O projeto sera instalado em: ${DESTINATION}"

if is_project_directory "${DESTINATION}"; then
    echo "O projeto ja esta baixado. A instalacao existente sera utilizada."
else
    if [[ -e "${DESTINATION}" ]] && [[ -n "$(find "${DESTINATION}" -mindepth 1 -maxdepth 1 -print -quit)" ]]; then
        echo "A pasta de destino ja existe e contem outros arquivos: ${DESTINATION}" >&2
        exit 1
    fi

    command -v curl >/dev/null 2>&1 || { echo "curl nao foi encontrado." >&2; exit 1; }
    [[ -x /usr/bin/ditto ]] || { echo "ditto nao foi encontrado neste macOS." >&2; exit 1; }

    TEMPORARY_DIRECTORY="$(mktemp -d "${TEMP_BASE}/correcao-nome-latam.XXXXXX")"
    ARCHIVE_PATH="${TEMPORARY_DIRECTORY}/projeto.zip"
    EXTRACTED_PATH="${TEMPORARY_DIRECTORY}/extraido"

    echo ""
    echo "==> Baixando o projeto publico do GitHub"
    curl --fail --location --proto '=https' --tlsv1.2 \
        --output "${ARCHIVE_PATH}" "${ARCHIVE_URL}"

    echo ""
    echo "==> Extraindo os arquivos"
    mkdir -p "${EXTRACTED_PATH}"
    /usr/bin/ditto -x -k "${ARCHIVE_PATH}" "${EXTRACTED_PATH}"
    SOURCE_PATH="${EXTRACTED_PATH}/correcao-nome-latam-main"
    is_project_directory "${SOURCE_PATH}" || { echo "O download nao contem a estrutura esperada." >&2; exit 1; }

    mkdir -p "${DESTINATION}"
    find "${SOURCE_PATH}" -mindepth 1 -maxdepth 1 -exec mv {} "${DESTINATION}/" \;
    is_project_directory "${DESTINATION}" || { echo "O projeto nao foi copiado corretamente." >&2; exit 1; }
    echo "Projeto baixado com sucesso."
fi

if (( DOWNLOAD_ONLY == 1 )); then
    echo "Download validado em: ${DESTINATION}"
    exit 0
fi

echo ""
echo "==> Iniciando a instalacao guiada"
cd "${DESTINATION}"
/bin/bash ./scripts/install.sh

echo ""
echo "==> Concluido"
echo "Para iniciar novamente: cd \"${DESTINATION}\" && npm start"

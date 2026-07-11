#!/bin/bash

set -Eeuo pipefail

MINIMUM_NODE_MAJOR=22
TARGET_NODE_MAJOR=24
BASE_URI="https://nodejs.org/dist/latest-v${TARGET_NODE_MAJOR}.x"

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
PROJECT_ROOT="$(CDPATH= cd -- "${SCRIPT_DIR}/.." && pwd -P)"

TEMP_DIR=""
SUMS_PATH=""
PKG_PATH=""
NODE_VERSION=""
NODE_MAJOR=0
NODE_USABLE=0

step() {
    printf '\n==> %s\n' "$1"
}

die() {
    printf '\nFalha na instalacao: %s\n' "$1" >&2
    exit 1
}

cleanup() {
    if [[ -n "${PKG_PATH}" && -f "${PKG_PATH}" ]]; then
        rm -f -- "${PKG_PATH}" || true
    fi
    if [[ -n "${SUMS_PATH}" && -f "${SUMS_PATH}" ]]; then
        rm -f -- "${SUMS_PATH}" || true
    fi
    if [[ -n "${TEMP_DIR}" && -d "${TEMP_DIR}" ]]; then
        rmdir -- "${TEMP_DIR}" 2>/dev/null || true
    fi
    return 0
}

trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

confirm() {
    local prompt="$1"
    local answer=""

    while true; do
        printf '%s [s/N] ' "${prompt}"
        if [[ -r /dev/tty ]]; then
            IFS= read -r answer </dev/tty || return 1
        else
            IFS= read -r answer || return 1
        fi

        case "${answer}" in
            s|S|sim|Sim|SIM|y|Y|yes|Yes|YES) return 0 ;;
            ""|n|N|nao|Nao|NAO|no|No|NO) return 1 ;;
            *) printf 'Resposta invalida. Digite s ou n.\n' ;;
        esac
    done
}

require_command() {
    command -v "$1" >/dev/null 2>&1 || die "Comando obrigatorio nao encontrado: $1"
}

detect_node() {
    NODE_VERSION=""
    NODE_MAJOR=0
    NODE_USABLE=0

    if ! command -v node >/dev/null 2>&1; then
        return 0
    fi

    if ! NODE_VERSION="$(node --version 2>/dev/null)"; then
        return 0
    fi

    NODE_MAJOR="${NODE_VERSION#v}"
    NODE_MAJOR="${NODE_MAJOR%%.*}"
    if ! [[ "${NODE_MAJOR}" =~ ^[0-9]+$ ]]; then
        NODE_MAJOR=0
        return 0
    fi

    if (( NODE_MAJOR >= MINIMUM_NODE_MAJOR )) && command -v npm >/dev/null 2>&1; then
        NODE_USABLE=1
    fi
}

download_official() {
    local uri="$1"
    local destination="$2"

    case "${uri}" in
        https://nodejs.org/*) ;;
        *) die "Download recusado: a origem precisa ser https://nodejs.org." ;;
    esac

    curl --fail --location --silent --show-error \
        --proto '=https' --tlsv1.2 \
        --output "${destination}" "${uri}"
}

install_node_24() {
    local pkg_name=""
    local expected_sha=""
    local actual_sha=""
    local signature_output=""

    if ! confirm "Deseja instalar o Node.js ${TARGET_NODE_MAJOR} LTS neste computador?"; then
        die "Node.js >= ${MINIMUM_NODE_MAJOR} e necessario para continuar. Instalacao nao autorizada."
    fi

    require_command curl
    require_command awk
    require_command shasum
    require_command grep
    require_command sudo

    [[ -x /usr/sbin/pkgutil ]] || die "pkgutil nao esta disponivel neste macOS."
    [[ -x /usr/sbin/installer ]] || die "installer nao esta disponivel neste macOS."

    TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/latam-name-bot.XXXXXX")" || die "Nao foi possivel criar um diretorio temporario."
    SUMS_PATH="${TEMP_DIR}/SHASUMS256.txt"

    step "Obtendo metadados oficiais do Node.js ${TARGET_NODE_MAJOR} LTS"
    download_official "${BASE_URI}/SHASUMS256.txt" "${SUMS_PATH}"

    pkg_name="$(awk '$2 ~ /^node-v24\.[0-9]+\.[0-9]+\.pkg$/ { print $2; exit }' "${SUMS_PATH}")"
    expected_sha="$(awk '$2 ~ /^node-v24\.[0-9]+\.[0-9]+\.pkg$/ { print tolower($1); exit }' "${SUMS_PATH}")"

    [[ "${pkg_name}" =~ ^node-v24\.[0-9]+\.[0-9]+\.pkg$ ]] || die "O manifesto oficial nao contem o pacote macOS esperado."
    [[ "${expected_sha}" =~ ^[0-9a-f]{64}$ ]] || die "O SHA-256 publicado para o pacote e invalido."

    PKG_PATH="${TEMP_DIR}/${pkg_name}"
    step "Baixando o pacote oficial ${pkg_name}"
    download_official "${BASE_URI}/${pkg_name}" "${PKG_PATH}"

    step "Verificando SHA-256 e assinatura do pacote"
    actual_sha="$(shasum -a 256 "${PKG_PATH}" | awk '{ print tolower($1) }')"
    [[ "${actual_sha}" == "${expected_sha}" ]] || die "SHA-256 invalido. O pacote nao sera executado."

    if ! signature_output="$(LC_ALL=C /usr/sbin/pkgutil --check-signature "${PKG_PATH}" 2>&1)"; then
        printf '%s\n' "${signature_output}" >&2
        die "A assinatura do pacote nao e valida. O pacote nao sera executado."
    fi

    if ! printf '%s\n' "${signature_output}" | grep -Eiq 'Status: signed'; then
        printf '%s\n' "${signature_output}" >&2
        die "O pacote nao possui uma assinatura reconhecida pelo macOS."
    fi

    if ! printf '%s\n' "${signature_output}" | grep -Eiq 'Node\.js|OpenJS'; then
        printf '%s\n' "${signature_output}" >&2
        die "A identidade do assinante nao corresponde ao projeto Node.js/OpenJS."
    fi

    printf '%s\n' "${signature_output}"
    step "Instalando o pacote oficial (o macOS solicitara sua senha)"
    sudo /usr/sbin/installer -pkg "${PKG_PATH}" -target /

    export PATH="/usr/local/bin:${PATH}"
    hash -r
    detect_node

    if (( NODE_USABLE != 1 || NODE_MAJOR != TARGET_NODE_MAJOR )); then
        die "Node.js ${TARGET_NODE_MAJOR} foi instalado, mas nao ficou disponivel. Abra um novo Terminal e execute este script outra vez."
    fi

    printf 'Node.js %s e npm foram encontrados.\n' "${NODE_VERSION}"
}

run_npm_step() {
    local description="$1"
    shift

    step "${description}"
    if ! npm "$@"; then
        die "O comando npm $* falhou."
    fi
}

main() {
    [[ "$(uname -s)" == "Darwin" ]] || die "Este script e exclusivo para macOS. No Windows, use scripts/install.ps1."
    [[ -f "${PROJECT_ROOT}/package.json" ]] || die "package.json nao foi encontrado em ${PROJECT_ROOT}. Execute o script dentro do projeto completo."
    [[ -f "${PROJECT_ROOT}/package-lock.json" ]] || die "package-lock.json nao foi encontrado. O bootstrap exige um lockfile para executar npm ci."

    printf 'Instalador guiado - Bot de correcao de nome LATAM\n'
    printf 'Projeto: %s\n' "${PROJECT_ROOT}"
    printf 'Este processo verifica Node.js >= %s, instala dependencias, executa testes e inicia a configuracao.\n' "${MINIMUM_NODE_MAJOR}"

    if ! confirm "Deseja continuar?"; then
        printf 'Instalacao cancelada. Nenhuma alteracao foi feita.\n'
        return 0
    fi

    detect_node
    if (( NODE_USABLE == 1 )); then
        printf 'Node.js %s encontrado em %s.\n' "${NODE_VERSION}" "$(command -v node)"
    else
        if [[ -n "${NODE_VERSION}" ]]; then
            printf 'Node.js %s nao atende aos requisitos ou esta sem npm.\n' "${NODE_VERSION}"
        else
            printf 'Node.js nao foi encontrado.\n'
        fi
        install_node_24
    fi

    cd "${PROJECT_ROOT}"
    run_npm_step "Instalando dependencias exatas com npm ci" ci
    run_npm_step "Executando testes" test
    run_npm_step "Iniciando o assistente de configuracao" run setup

    step "Instalacao concluida"
}

main "$@"

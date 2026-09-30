#!/bin/sh
# Instala los git hooks del repo. Correr una vez por clon: sh scripts/install-hooks.sh
cp scripts/hooks/pre-commit .git/hooks/pre-commit
chmod +x .git/hooks/pre-commit
echo "hook pre-commit instalado (espejo frontend automático)"

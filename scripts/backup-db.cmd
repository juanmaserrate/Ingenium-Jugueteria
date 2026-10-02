@echo off
REM Backup diario de la base de Ingenium (lo ejecuta el Programador de tareas).
set "PATH=C:\Program Files\nodejs;%PATH%"
cd /d "C:\Users\Usuario\Desktop\Ingenium\backend"
echo ---------- %DATE% %TIME% ---------- >> "C:\Users\Usuario\Desktop\Ingenium\backups\backup.log"
call "C:\Users\Usuario\AppData\Roaming\npm\railway.cmd" run --service Postgres "C:\Program Files\nodejs\node.exe" "scripts\backup-db.mjs" < NUL >> "C:\Users\Usuario\Desktop\Ingenium\backups\backup.log" 2>&1

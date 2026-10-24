# Ручной мост Git → проверенный релиз → сервер

Это **не автоматический deploy main** и не настройка GitHub Actions. Оператор запускает обновление только после явного согласования конкретного опубликованного commit. Скрипт не подключается к GitHub/облаку, не управляет сервисом, не читает env и не восстанавливает БД.

## Источник истины и receipt

1. На управляющей машине сверить текущий remote `main`/PR. Опубликовать reviewed-кандидат обычной веткой/PR только с разрешения; сохранить точные remote commit и tree. Проверенная исходная точка: PR №9, remote commit `11a9f72b37adfce74574ff1978587fcbbbcda50c`, tree `f0c14f1ff623375e0980024f4de4004962dc33ed`, локальный эквивалент `716f8fdfc0f30abdd16935d80081c9718b0c8863`. Это не означает merge PR9 в main; новые релизы требуют новой сверки.
2. Из точного Git tree собрать ZIP только tracked source: без `.git`, `node_modules`, рабочих `.env`, SQLite/ключей. Включить `package-lock.json`; примерные пустые env допустимы. Для каждого файла записать mode, размер и SHA256. Сверить весь ZIP с tree на управляющей машине, не только имя архива.
3. Сформировать receipt ниже. Доставить архив, receipt и reviewed helper по уже разрешённому административному каналу. GitHub credential на VM не нужен. Receipt — доверенная запись оператора о проверке Git, **не цифровая подпись**; его подлинность зависит от согласованного канала. Offline helper не утверждает, что самостоятельно проверил GitHub.

```json
{
  "schemaVersion": 1,
  "repository": "sakrett001-ai/Lazy-work-planer",
  "remoteGitCommit": "<40 hex: verified published commit>",
  "remoteGitTree": "<40 hex: verified tree>",
  "localCandidateCommit": "<optional local commit; never a substitute>",
  "releaseDirectory": "<optional 8..40 hex directory alias, otherwise remoteGitCommit>",
  "remoteVerifiedAt": "<UTC verification timestamp>",
  "archiveSha256": "<64 hex>",
  "files": [{"path":"package.json","mode":"100644","bytes":123,"sha256":"<64 hex>"}]
}
```

VM deployment layout согласован как `/opt/pulse` → `/opt/pulse-releases/<revision>`, `pulse.service`, service user `pulse`, данные `/var/lib/pulse`, env `/etc/pulse/pilot.env`, Node `/opt/node-v24.22.1-linux-x64/bin/node`. **Перед первым использованием сверить фактический layout**, текущий symlink и unit. Скрипт не переоборудует старый прямой каталог в symlink. Unit должен использовать `WorkingDirectory=/opt/pulse` и `ExecStart=/opt/node-v24.22.1-linux-x64/bin/node scripts/pilot-server.mjs` (**относительный путь к скрипту**). Абсолютный `/opt/pulse/scripts/pilot-server.mjs` через symlink может не пройти текущий main-guard и завершиться без listener; состояние «процесс завершился с кодом 0» не является health. Не менять уже работающую установку скрыто ради инструкции. Первый VM-каталог фактически назван `/opt/pulse-releases/716f8fdf`; его receipt должен явно связывать `releaseDirectory: "716f8fdf"` с remote commit `11a9f72b37adfce74574ff1978587fcbbbcda50c`. Перед первым update сверить полный manifest его source и установить проверенный receipt отдельно, не пересоздавая каталог/БД. Без receipt helper не обещает rollback на этот старый релиз и откажет в переключении на него.

## Подготовка без остановки действующего сервиса

- Проверить доступное место на файловых системах releases **и данных/backups**: новый source+`node_modules`+временные файлы+проверенная полная копия SQLite и ключа+предыдущий релиз. Helper проверяет только source×2 +256MiB запаса, **это не оценка размера npm/БД**. Если места недостаточно — остановиться, не удалять последнюю рабочую копию автоматически.
- Проверить `readlink -f /opt/pulse` и записать `OLD`; сохранить текущий remote revision/receipt. `NEW` и receipt должны указывать на новый согласованный Git commit. Хэши передавать как данные, не угадывать из имени файла.
- Подготовить приватный staging и каталоги через администратора. Existing release root должен принадлежать доверенному оператору, быть недоступным для записи сервису. Запуск helper:

```sh
python3 /trusted/manual-release.py prepare \
  --archive /private/upload/release.zip --receipt /private/upload/release.json \
  --releases /opt/pulse-releases
```

Helper проверяет ZIP/hash/полный список/каждый файл, запрещает traversal, ссылки и runtime-файлы, не перезаписывает релиз. Созданный release изначально `0700`: **до запуска сервиса** оператор устанавливает нужные права чтения каталогов и файлов; receipt хранить `0600`. Для установки зависимостей/проверок дать только новому candidate временного непривилегированного владельца, затем снова сделать source/root-owned и недоступным сервису для записи. Не запускать npm или тесты от root.

- Выполнить в candidate как непривилегированный пользователь, **без production env/ключей/базы**, с чистым HOME и отдельным временным `ASSISTANT_DATA_DIR`. Задать AI/delivery=false. Пример команд внутри такого изолированного контекста:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run typecheck
npm test
```

Используется существующий lockfile и integrity npm; lockfile не обновлять, lifecycle scripts не включать ради обхода ошибки. Если `--ignore-scripts` несовместим с выбранной официальной зависимостью — остановиться и отдельно проверить причину, а не запускать неподтверждённый install hook. Текущий helper не исполняет npm сам. Зафиксировать точный Node/npm, exit codes, число тестов и receipt. Не копировать старый `node_modules` как доказательство воспроизводимой установки. Доступ к registry — отдельная разрешённая операция среды, эта локальная разработка её не выполняла.

## Короткое окно переключения

1. Проверить отсутствие неожиданных изменений схемы/формата данных между OLD/NEW. Релиз с необратимой миграцией требует отдельного migration/restore плана; **этот мост для совместимых релизов**.
2. Остановить `pulse.service`, убедиться, что он действительно `inactive` и процесс завершён. Не выдавать `systemctl restart` за проверку остановки. AI/delivery остаются OFF в прежнем `/etc/pulse/pilot.env`; не генерировать новые приглашения и не заменять файл env.
3. С доверенного OLD кода выполнить существующий `scripts/backup-state.mjs` с `ASSISTANT_DATA_DIR=/var/lib/pulse`, новым приватным backup-path вне releases. Он делает SQLite `VACUUM INTO`, `integrity_check` и копию `llm-master.key` при наличии подключений. Проверить успешный exit и наличие копии `0600`; ключ и БД хранить вместе. Не читать ключ в терминал. Проверка не прошла — **не переключать**; возобновить OLD и проверить health.
4. Только после install/tests/backup/root-owned source переключить указатель:

```sh
python3 /trusted/manual-release.py switch --releases /opt/pulse-releases \
  --revision "$NEW_SHA" --current /opt/pulse --expected "$OLD"
# затем оператор запускает pulse.service и проверяет его статус
```

Helper повторно проверяет source hashes, проверяет expected-current под cooperative lock и делает `os.replace` временного symlink. Не останавливает процесс сам. Другие администраторы должны пользоваться тем же lock/окном; нельзя обещать защиту от root, меняющего указатель вне процедуры. Переключение pointer атомарно, весь deploy не является одной транзакцией.

5. Health с ограниченным timeout: `/assistant/workspace`=200 с ожидаемым HTML; `/assistant/pilot-theme.css`=200 с ожидаемым хэшем; **анонимный** `/assistant/api/tasks`=401. По loopback `127.0.0.1:8787` передавать `Host`, совпадающий с публичным `ASSISTANT_SERVER_ORIGIN` (сервер проверяет его строго). Проверить публичный HTTPS отдельно, не использовать `-k`/отключение TLS. Проверить сохранность рабочего сценария с разрешённой тестовой учёткой; не логировать cookies/коды. Проверить фактический `/opt/pulse` и записать remote commit/health receipt.

## Откат кода

При failed health остановить новый сервис и сохранить диагностический статус без env/ключей/тел сообщений. После подтверждения совместимости **текущей БД** со старым кодом выполнить тот же `switch` с OLD revision и `--expected` NEW-path, запустить сервис и повторить health. Новые сообщения/записи не должны теряться.

**Не восстанавливать backup SQLite автоматически**, не заменять файл поверх живой WAL-БД и не откатывать ключ отдельно. Если новый код менял схему несовместимо — остановиться и получить отдельное решение по восстановлению/потере новых записей. Сохранить OLD/NEW/backup до подтверждения результата; автоматической очистки нет.

## Проверка самого helper

`node --test tests/manual-release.test.mjs`: синтетические ZIP/manifest, повреждённые bytes, traversal/symlink, неопубликованный candidate, expected-pointer conflict, изменение source после подготовки, switch/rollback без изменения sentinel-БД. Это не тест живого systemd, облачной доставки, npm registry или публичного HTTPS. Рабочий server update здесь не выполнялся.

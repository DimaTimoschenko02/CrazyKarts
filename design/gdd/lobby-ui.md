# Lobby UI Redesign

> **Status**: Designed (not implemented)
> **Author**: ux-designer
> **Last Updated**: 2026-04-26
> **Milestone**: Beta (B / C — depends on Rooms System B1 and Profile System B2)
> **Implements Pillar**: Играй с друзьями (zero-friction join — публичный список комнат, одно нажатие)

---

## Overview

Lobby UI — точка входа в игру. Текущая версия (единый VBox с полем IP) не поддерживает
новые системы: Rooms (B1) с публичным списком комнат и Profile (B2) с авто-логином по токену.

Цель редизайна: игрок открывает сайт, видит список активных комнат, нажимает на комнату
друга — и через три секунды уже там. Без IP, без ввода кодов, без объяснений. Создать
комнату — одна кнопка, без конфигурации. Список обновляется сам.

Invite-код (`?join=CODE` в URL) остаётся как дополнительный канал для Discord-шаринга,
но не является основным UI-паттерном. Ручной ввод кода через форму — убран.

Реализуется как набор Control-панелей с программным переключением (не TabContainer —
нужны анимированные переходы). Текущие `lobby.gd` и `lobby.tscn` подлежат полному
рефакторингу.

---

## Player Fantasy

"Вася сказал 'идём'. Открываю сайт — вижу список: 'Васи комната 2/8 WAITING'. Кликнул.
Игра спросила ник — один раз, потом запомнит. Три секунды — и я в лобби, вижу Васю.
Пишу Коле в чат: 'заходи на smash-karts'. Коля открывает — видит ту же комнату в списке,
нажимает. Всё. Никто ни разу не произнёс слово 'IP-адрес' или 'введи код'."

---

## Detailed Design

### 1. Information Architecture

```
[Splash / Auth Check]
  Читает smash_karts_token из localStorage.
  ├─ token валиден → GET /api/profile/auth → профиль найден → [Lobby Home]
  ├─ token есть, но API вернул 404 → профиль не найден → [First-time / Pick Nickname]
  └─ token отсутствует → [First-time / Pick Nickname]

  Если localStorage недоступен (incognito) → [First-time / Pick Nickname] в guest-mode
  Если ?join=CODE в URL → сохранить _pending_join_code до завершения auth/first-time

[First-time / Pick Nickname]
  ├─ Ввод ника → live validation → "Создать профиль" → [Lobby Home]
  └─ (если _pending_join_code есть) → после создания профиля → [Room Lobby (guest)]

[Lobby Home: профиль + список комнат]  ← ГЛАВНЫЙ ЭКРАН
  ├─ нажал на карточку комнаты → GET /api/rooms/{code} → [Room Lobby (guest)]
  ├─ "Создать комнату" → POST /api/rooms → [Room Lobby (host)]
  ├─ (иконка профиля) → [Profile Dashboard]
  └─ "Выйти" → очищает localStorage → [First-time / Pick Nickname]

  Нет кнопки "Войти по коду". Нет Join by Code модалки.
  Deep link ?join=CODE обрабатывается в [Splash] — минует [Lobby Home] полностью.

[Room Lobby]  ← единый экран для host и guest
  ├─ список игроков (ник, ping, статус)
  ├─ opt-in "Поделиться ссылкой" → копирует ?join=CODE в clipboard
  ├─ (host only) кнопка "Старт" — активна при ≥2 игроках
  ├─ "Покинуть" → [Lobby Home]
  └─ match start → fade out → game scene

[Profile Dashboard]
  ├─ stats overview (K/D, матчи, урон)
  ├─ "Сменить аккаунт" → очистить localStorage → [First-time]
  └─ "Назад" → [Lobby Home]
```

---

### 2. Auto-join via URL (Deep Linking)

URL-параметры читаются через `JavaScriptBridge.eval()` как сейчас в `lobby.gd._get_url_param()`.
Логика расширяется новыми параметрами.

#### `?join=CODE`

Только код комнаты (6 символов, charset без 0/O/I/1).

**Флоу:**
1. `[Splash]` читает `?join` параметр и сохраняет в переменной `_pending_join_code`.
2. Если auth-token валиден → сразу `GET /api/rooms/{code}` → `[Room Lobby]`.
3. Если профиля нет → `[First-time / Pick Nickname]` с баннером
   "Тебя пригласили в комнату CODE. Введи ник — и вперёд!".
4. После создания профиля → авто-джоин по сохранённому `_pending_join_code`.

**UX-правило:** пользователь никогда не теряет контекст приглашения. Код хранится в
переменной сессии до момента успешного подключения или явной отмены.

#### `?join=CODE&name=NAME`

Оба параметра — "прямой гостевой" режим. Сценарий: хост сформировал ссылку вида
`?join=XKCD42&name=Kolya` и скинул конкретному человеку.

**Флоу:**
1. `[Splash]` читает оба параметра.
2. Если в localStorage нет токена → `[First-time]` с nickname-полем, предзаполненным
   `NAME`. Пользователь видит своё имя уже вписанным, нажимает "Создать профиль"
   (или меняет ник если не хочет этот).
3. Если имя занято → conflict flow (предложение вариантов от сервера).
4. После успешной регистрации → джоин по `CODE`.
5. Если токен уже есть (возвратный игрок) → параметр `name` игнорируется, используется
   никнейм из профиля. Сразу джоин по `CODE`.

**Примечание:** параметр `name` не создаёт "одноразовый guest без профиля" —
минимальный профиль всё равно создаётся. Это упрощает статистику и исключает edge-cases
с анонимными сессиями. Единственное исключение — localStorage полностью заблокирован
(см. раздел Edge Cases).

#### `?profile=create`

Форсирует открытие `[First-time / Pick Nickname]` независимо от наличия токена.
Используется для сценария "хочу зарегистрировать другой аккаунт".

Реализация: при чтении этого параметра токен в localStorage не удаляется немедленно —
удаляется только после успешного создания нового профиля и нажатия "Создать профиль".

#### `?profile=token=XXX` (отладочный)

Форсирует установку токена в localStorage и редирект на Lobby Home. Доступен только
если `OS.is_debug_build()` возвращает true. В production-билдах игнорируется.

---

### 3. First-time / Pick Nickname

**Назначение**: единственный экран где пользователь взаимодействует с системой профилей.
Показывается при первом заходе или после "Выйти".

**Структура экрана:**

```
[Заголовок] "Добро пожаловать! Выбери ник"

[Поле ввода]  placeholder: "Твой ник..."
              max_length: 20 символов
              allowed: A-Za-z0-9_-

[Статус-строка]  — вот здесь живёт inline feedback:
  • пустая пока не введено 2+ символов
  • "Проверяем..." — debounced API вызов (400ms после последнего keystroke)
  • "Ник свободен!" — зелёная
  • "Занят. Попробуй: [Вася_2] [Вася47] [ВасяX]" — варианты как кнопки-чипы
  • "Только буквы, цифры, _ и -" — при invalid charset
  • "Минимум 2 символа" — при короткой строке

[Кнопка "Создать профиль"]
  — disabled пока nick не прошёл валидацию (длина OK + charset OK + available)
  — при нажатии: spinner, затем переход

[Мелкий текст внизу]  "Сохраняем ник в браузере. Другие браузеры/устройства
                        потребуют повторной регистрации."
```

**Валидация — клиентская (instant, синхронная):**
- Длина < 2 → показать "Минимум 2 символа", кнопка disabled
- Длина > 20 → input обрезает (max_length на LineEdit)
- Недопустимые символы → "Только буквы, цифры, _ и -", кнопка disabled

**Валидация — серверная (async, debounced 400ms):**
- `GET /api/profile/check?nick=VALUE` (или `POST /api/profile/register` с dry-run флагом)
- Занят → показать conflict suggestions как кнопки-чипы. Клик на чип → вставляет вариант в поле → повторная валидация
- Зарезервированный nick (server/admin/etc.) → "Это имя недоступно"
- API недоступен → "Не удалось проверить ник. Попробовать?" + кнопка retry. Кнопка "Создать" разблокируется через 3 сек ожидания (fallback — позволяем попробовать)

**Создание профиля:**
1. `POST /api/profile/register { nickname }` → получаем `{ token, nickname_display }`
2. Сохраняем `token` в `localStorage["smash_karts_token"]`
3. Сохраняем `nickname_display` в `PlayerData.my_name` (autoload)
4. Если был `_pending_join_code` → переходим в `_join_room(code)` → `[Room Lobby]`
5. Иначе → переходим на `[Lobby Home]`

**Восстановление аккаунта:**
MVP — нет механизма восстановления через ввод ника (это бы позволило угнать аккаунт).
Единственный способ — иметь токен. Внизу экрана мелкий текст: "Если потерял аккаунт —
нужен токен из localStorage. Сохрани его заблаговременно." Без кнопки, без формы.

---

### 4. Lobby Home

Главный хаб. Отображается для авторизованного игрока. Центральный элемент — список
активных публичных комнат. Ручного ввода кода здесь нет.

**Layout (структурный, без визуала):**

```
┌─────────────────────────────────────────┐
│  [Аватар]  [Ник]  [K/D]    [⚙ Профиль] │  ← Header
├─────────────────────────────────────────┤
│                                          │
│  Активные комнаты:                       │  ← Room List (центр)
│  ┌───────────────────────────────────┐   │
│  │ Васи комната      3/8  WAITING  [Войти]│
│  │ Колина тусовка    8/8  FULL      [—]  │
│  │ Дима's room       2/8  IN_MATCH  [—]  │
│  └───────────────────────────────────┘   │
│  (список пуст → empty state, см. ниже)  │
│                                          │
│         [+ Создать комнату]              │  ← Primary CTA, снизу
│                                          │
├─────────────────────────────────────────┤
│  v0.1.0                    [Discord]    │  ← Footer
└─────────────────────────────────────────┘
```

**Header:**
- Инициалы или avatar-placeholder (круг с первой буквой ника)
- Никнейм (как в `PlayerData.my_name` — canonical display form)
- K/D ratio из загруженного профиля (если API был доступен) или "—" если нет
- Иконка-кнопка "Профиль" → `[Profile Dashboard]`

**Room List (основная область):**
- `GET /api/rooms` при каждом показе экрана + авто-refresh каждые 4 секунды
- Каждая карточка показывает: имя комнаты, ник хоста, текущих/макс игроков, статус, кнопку
- Статусы и доступность кнопки "Войти":
  - `WAITING` → кнопка активна, зелёная. Нажатие → `GET /api/rooms/{code}` → `[Room Lobby]`
  - `FULL` (current_players >= max_players) → кнопка disabled, текст "—" или "Полная"
  - `IN_MATCH` → кнопка disabled, текст "В игре". Join в IN_MATCH недоступен (v2)
- Карточки сортированы: сначала WAITING, затем IN_MATCH, затем FULL
- Список скроллируется если комнат > 5 (при целевой нагрузке ≤ 3 комнаты — редко)
- Refresh indicator: ненавязчивый (мигание иконки или timestamp "обновлено X с назад")
  без спиннера — список не пустеет на время запроса, просто обновляется in-place

**Empty state (список пуст):**
```
┌───────────────────────────────────────┐
│                                        │
│     Нет активных комнат               │
│                                        │
│     Будь первым — создай комнату!     │
│                                        │
│         [+ Создать комнату]            │
│                                        │
└───────────────────────────────────────┘
```
CTA кнопка в empty state дублирует основную кнопку внизу — оба делают одно и то же.

**Кнопка "Создать комнату" (primary CTA):**
- Одна кнопка, всегда видна в нижней части экрана
- Нажатие → Create Room flow (см. секцию 5). Без промежуточного диалога.
- Комната создаётся с дефолтными настройками (см. секцию 5)

**Refresh и polling:**
- Интервал: 4 секунды. Достаточно свежо при целевой нагрузке ~10 человек.
- Реализация: `Timer` в `LobbyHomePanel`, `GET /api/rooms` без блокировки UI
- При ошибке запроса (timeout/5xx): список не очищается, показать subtle индикатор
  "Нет связи — пробуем снова..." без блокирующего сообщения
- Exponential backoff при последовательных ошибках: 4s → 8s → 16s → 30s (cap)
- WebSocket-push (v2): polling достаточен для MVP при данной нагрузке

**Footer:**
- Версия игры слева (берётся из константы, не хардкодить)
- Ссылка на Discord/обратную связь справа (опционально)

---

### 5. Create Room Flow

**Сценарий:** пользователь нажимает "Создать комнату" на Lobby Home (или в empty state).

**Дефолтные параметры комнаты:**
- `name`: `"{nickname}'s room"` — генерируется автоматически из ника хоста
- `max_players`: 8
- `map`: `"map_1"` (единственная карта)
- `type`: `"PUBLIC"` — комната сразу видна в списке

Никакого диалога перед созданием нет. Одно нажатие = комната создана = host в Room Lobby.

```
1. Кнопка переходит в состояние loading (spinner + текст "Создаём комнату...")
2. HTTP POST /api/rooms { name: nickname + "'s room", type: "PUBLIC",
                          max_players: 8, map: "map_1", host_name: nickname }
   ← { room_code, room_id, ws_url, invite_link }
3. NetworkManager.join_game(ws_url) — подключаемся к Godot-процессу комнаты
4. Переход на [Room Lobby] как host. Никакой "Комната создана!" модалки.
   Комната уже видна в списке у других — не нужно показывать invite-код принудительно.
```

**"Поделиться ссылкой" в Room Lobby (opt-in):**
- Invite-код доступен из Room Lobby как вторичное действие
- Кнопка "Поделиться ссылкой" → копирует `https://домен/?join=CODE` в clipboard
- После копирования: кнопка на 1.5с показывает "Скопировано!" (текстом)
- Если clipboard API недоступен → показать поле с текстом для ручного копирования (auto-select)

**Ошибки:**
- API вернул ошибку → закрыть spinner, toast "Не удалось создать комнату.
  Попробуй ещё раз." Кнопка "Создать комнату" снова активна.
- Timeout (>5s) → то же самое поведение

**v2:** кастомное имя и выбор карты — через форму перед созданием. В MVP — дефолт.

---

### 6. Join by Code — только через Deep Link

**Ручного ввода кода в UI нет.** Join by Code модалка удалена.

Единственный путь по коду — URL параметр `?join=CODE`, который обрабатывается в `[Splash]`
ещё до показа Lobby Home. Это покрывает основной use-case Discord-шаринга: хост нажимает
"Поделиться ссылкой" в Room Lobby → копирует ссылку → кидает в чат → остальные кликают.

**Почему модалка убрана:**
- Основной flow — список комнат. Если комната видна в списке, код вводить не нужно.
- Если комнаты нет в списке (сервер перезапустился, комната закрылась) — создать новую.
- URL deep link полностью покрывает сценарий "скинул ссылку в Discord".
- Лишняя модалка усложняет IA без ощутимой пользы при целевой аудитории ~10 человек.

**Обработка `?join=CODE` при открытии:** см. секцию 2 (Auto-join via URL).

---

### 7. Room Lobby (Waiting Room)

Единый экран для хоста и гостя. Роль (host/guest) определяет видимость кнопки "Старт".

**Layout:**

```
┌────────────────────────────────────────────┐
│  Комната: [имя комнаты]           [Покинуть]│
├────────────────────────────────────────────┤
│                                             │
│  Игроки (3/8):                              │
│  ┌───────────────────────────────────────┐  │
│  │ ● Вася          42 ms   [host]        │  │
│  │ ● Kolya         87 ms                 │  │
│  │ ○ Dima          connecting...        │  │
│  └───────────────────────────────────────┘  │
│                                             │
│  Пригласи друзей:                           │
│  ┌──────────┐  ┌──────────────────────┐    │
│  │  XYZ123  │  │ Скопировать ссылку   │    │
│  └──────────┘  └──────────────────────┘    │
│  [Скопировать код]                          │
│                                             │
│       [Старт] ← (только у host)            │
│  Нужно минимум 2 игрока                     │
└────────────────────────────────────────────┘
```

**Список игроков:**
- Зелёная точка = подключён, серая = connecting
- Никнейм, ping (ms), метка [host] у первого зарегистрированного
- Обновляется в реальном времени через существующий Godot Multiplayer peer events
- Скроллируется если игроков > 6 (max_players может быть 10)

**Invite секция:**
- "Поделиться ссылкой" — одна кнопка, копирует `https://домен/?join=CODE` в clipboard
- Код комнаты показывается мелко рядом как read-only текст (для ориентации, не для набора)
- Отдельной кнопки "Скопировать код" нет — только ссылка (содержит код внутри)
- После копирования: кнопка на 1.5с показывает "Скопировано!", затем возвращается
- Если clipboard API недоступен → показать поле с URL для ручного копирования (auto-select)

**Кнопка Старт:**
- Видна только у host (peer_id == 1 в Godot Multiplayer API)
- Disabled если `current_players < 2`
- При нажатии: host инициирует countdown через существующий Match System
- Текст под кнопкой меняется: при 1 игроке "Нужно минимум 2 игрока",
  при 2+ "Готов к старту!"

**Кнопка Покинуть:**
- Guest → `NetworkManager.disconnect()` → `[Lobby Home]`
- Host → показать подтверждение "Если ты выйдешь, комната закроется для всех.
  Выйти?" [Да / Отмена]
- После disconnect: toast на Lobby Home "Ты покинул комнату."

**Host-промоушн:** при дисконнекте хоста — управляется Rooms Server и Godot
(первый оставшийся peer становится новым хостом). Lobby UI просто перечитывает список
игроков — кнопка Старт появляется у нового хоста автоматически.

**Переход в игру:**
- Host нажимает Старт → Match System COUNTDOWN начинается
- Все клиенты получают RPC → `[Room Lobby]` показывает overlay "3... 2... 1... GO!"
  поверх списка игроков
- По завершению countdown: `get_tree().change_scene_to_file(game_scene)` с fade

---

### 8. Profile Dashboard

**MVP scope** — минимальная реализация. Полноценный дашборд в v2.

**Layout MVP:**

```
┌───────────────────────────────┐
│  [← Назад]   Мой профиль     │
├───────────────────────────────┤
│  [Аватар]  Вася               │
│            Матчей: 42         │
│            K/D: 2.1           │
│            Урон: 18 400       │
├───────────────────────────────┤
│  [Сменить аккаунт]            │
│  Очистит данные в браузере.   │
│  Статистика сохранится на     │
│  сервере.                     │
└───────────────────────────────┘
```

**Данные:** берутся из профиля, загруженного при auth. Если API был недоступен — поля
показывают "—" без ошибки.

**"Сменить аккаунт":**
1. Показать confirm dialog "Выйти из аккаунта? Статистика останется на сервере. Чтобы войти снова — нужен токен."
2. При подтверждении: `localStorage.removeItem("smash_karts_token")` → `[First-time]`

**v2 additions (отложено):**
- История последних 10 матчей (таблица с kill/death/damage per match)
- Favourite weapon, nemesis, prey
- Кнопка "Скопировать токен" (для бекапа на другое устройство)
- Смена display-ника (если B2 разрешит)

---

### 9. Edge Cases

| Сценарий | Поведение |
|----------|-----------|
| localStorage заблокирован (incognito) | `[Splash]` обнаруживает исключение при обращении к localStorage → входит в guest-mode. `[First-time]` показывает баннер "Браузер в режиме инкогнито — ник не сохранится. Введи имя для этой сессии." Кнопка меняется на "Играть как гость [ИМЯ]". Профиль не создаётся, статистика не пишется. `PlayerData.my_name` устанавливается только на сессию. |
| Множественные вкладки одного игрока | Rooms System разрешает (разные peer_id). В Lobby UI нет проверки — это нормально для отладки. В списке игроков появятся два "Вася". |
| Дисконнект в Room Lobby | `NetworkManager.connection_failed` сигнал → возврат на `[Lobby Home]` + toast "Потеряно соединение с комнатой." |
| Master-server down при открытии | `[Splash]` auth-check timeout (3s) → если есть токен в localStorage, пробуем войти через cached profile (PlayerData.my_name из localStorage["smash_karts_nick"]). Если нет — открываем `[Lobby Home]` с баннером "Сервис статистики недоступен. Можно играть, но ник не сохранится." |
| Master-server down при создании комнаты | Spinner показывает 5s, затем: "Сервис недоступен. Попробуй позже." Кнопка разблокируется. |
| Комната умерла (Godot крашнул) | `NetworkManager.connection_failed` → `[Lobby Home]` + toast "Комната недоступна. Создай новую или попробуй другой код." |
| Invite code из URL — комната не найдена | Toast поверх `[Lobby Home]` (если уже авторизован) или сообщение на `[First-time]` "Комната с кодом XYZ123 не найдена. Создай новую." |
| Clipboard API недоступен | Fallback: показать popup с полем для ручного копирования. Поле auto-selected. |
| IN_MATCH при джоине | Если `GET /api/rooms/{code}` возвращает state=IN_MATCH → показать модалку "Матч идёт. Подождать до следующего раунда или войти сейчас?" Войти сейчас → late join через существующий Network Layer. |
| Потеря WebSocket во время Room Lobby | Если reconnect не настроен (MVP) → `_on_server_disconnected` → возврат на `[Lobby Home]` + toast |
| Токен есть, API вернул 404 (orphaned token) | Профиль удалён на сервере → показать `[First-time]` с сообщением "Твой профиль не найден на сервере. Создай новый." Старый токен удаляется из localStorage. |

---

### 10. Visual / Interaction Guidelines

**Визуальный стиль:** определяет art-director. В данном документе — только структура,
состояния и правила отзывчивости.

**Keyboard navigation:**
- Tab/Shift-Tab перемещает фокус между интерактивными элементами в логическом порядке
- Enter активирует focused кнопку
- Escape закрывает модалки (Join by Code, Create Room confirmation, Profile confirm dialogs)
- В поле ввода кода комнаты: Enter при длине 6 = сабмит
- Все кнопки и поля имеют visible focus ring (не только outline:none)

**Gamepad navigation (если планируется):**
- D-pad / левый стик перемещает между элементами
- A/Cross = confirm/activate
- B/Circle = back/escape
- Хотя бы базовая поддержка через `UIInputManager` (если существует) или Godot InputMap

**Touch targets:**
- Минимальный touch target: 44×44 px (iOS HIG / Material Design)
- Кнопки "Создать комнату" и "Войти по коду" на Lobby Home: минимум 120×60 px
- Chip-кнопки с вариантами ника: минимум 44px высота

**Loading states:**
- Splash/auth check: full-screen spinner (не skeleton — нет данных для показа)
- Create Room: кнопка disabled + spinner внутри кнопки
- Join Code submit: поле disabled + spinner рядом
- Profile load: поля статистики показывают "—" пока грузятся (не skeleton в MVP)

**Toast notifications:**
- Позиция: снизу по центру, z-index поверх всего
- Duration: 3 секунды, затем fade out
- Максимум 1 toast одновременно (новый заменяет предыдущий)
- Цвет: зависит от типа (success / error / info) — конкретные цвета у art-director

**Accessibility:**
- [ ] Все интерактивные элементы доступны с keyboard
- [ ] Геймпад: базовая навигация через Godot focus system
- [ ] Текст читаем при минимальном масштабе (≥14px effective)
- [ ] Состояния (активен/disabled/error) не передаются только цветом: иконки или текст тоже меняются
- [ ] Нет мигающего контента без предупреждения
- [ ] Subtitles не нужны (лобби без диалога)
- [ ] UI корректно отображается при 100%, 125%, 150% browser zoom

**Mobile considerations:**
- Браузерная игра открывается на телефоне по invite ссылке — нужно отобразить корректно
- Landscape preferred (игра 3D, portrait неудобен для gameplay)
- При portrait: показать overlay "Поверни устройство для лучшего опыта" (не блокировать полностью)
- Lobby Home и Join flow должны работать в portrait без горизонтального скролла
- Модалки: full-width на мобильных (не фиксированная ширина)

---

### 11. Code Integration

#### `scripts/lobby.gd` — полный рефакторинг

Текущий `lobby.gd` (111 строк) заменяется новым. Новая структура:

```gdscript
# lobby.gd — LobbyController
# Управляет переключением панелей и общим состоянием лобби

class_name LobbyController
extends Control

enum LobbyScreen {
    SPLASH,
    FIRST_TIME,
    LOBBY_HOME,
    ROOM_LOBBY,
    PROFILE_DASHBOARD,
}

@onready var splash_panel:     Control = $Panels/SplashPanel
@onready var first_time_panel: Control = $Panels/FirstTimePanel
@onready var lobby_home_panel: Control = $Panels/LobbyHomePanel
@onready var room_lobby_panel: Control = $Panels/RoomLobbyPanel
@onready var profile_panel:    Control = $Panels/ProfilePanel
@onready var toast_container:  Control = $ToastContainer

var _current_screen: LobbyScreen = LobbyScreen.SPLASH
var _pending_join_code: String = ""
var _current_room_code: String = ""
var _profile_data: Dictionary = {}

func _ready() -> void:
    # читаем URL параметры
    # проверяем localStorage token
    # определяем начальный экран
    _show_screen(LobbyScreen.SPLASH)
    _run_auth_check()

func _show_screen(screen: LobbyScreen) -> void:
    # скрываем все панели, показываем нужную
    # опционально: fade transition

func show_toast(message: String, type: String = "info") -> void:
    # type: "info" | "success" | "error"
    pass
```

Каждая панель — отдельный Control-узел с собственным скриптом:
- `SplashPanel` — spinner, логика auth check, URL param parsing
- `FirstTimePanel` — поле ника, debounced validation
- `LobbyHomePanel` — header, список комнат с polling, кнопка "Создать комнату", footer
- `RoomLobbyPanel` — список игроков, invite секция (кнопка "Поделиться"), кнопка Старт
- `ProfilePanel` — статистика, кнопка выхода

**Autoload `LobbyStateManager`:** не нужен отдельный. `LobbyController` (узел Lobby сцены)
хранит состояние лобби. Межпанельная коммуникация через сигналы:

```gdscript
signal profile_loaded(profile_data: Dictionary)
signal room_created(room_code: String, ws_url: String)
signal room_joined(room_code: String)
signal logout_requested()
```

#### `scenes/lobby.tscn` — реструктуризация

Текущая flat VBox заменяется:

```
Lobby (Control) [lobby.gd / LobbyController]
├── BG (ColorRect)
├── Panels (Control)
│   ├── SplashPanel (Control) [splash_panel.gd]
│   ├── FirstTimePanel (Control) [first_time_panel.gd]
│   ├── LobbyHomePanel (Control) [lobby_home_panel.gd]
│   ├── RoomLobbyPanel (Control) [room_lobby_panel.gd]
│   └── ProfilePanel (Control) [profile_panel.gd]
├── ToastContainer (Control) [toast_manager.gd]
└── ModalLayer (Control)       ← только confirm-диалоги (выход хоста, logout)
    └── ConfirmModal (Control) [confirm_modal.gd]
```

`JoinCodeModal` удалена — Join by Code UI больше не существует в клиенте.

Каждая панель полностью заполняет экран (anchors preset = Full Rect). Видима только одна.

#### HTTP Client для master-server

Godot-side HTTP делается через `HTTPRequest` node. Не создавать новый autoload —
HTTP-логику инкапсулировать в helper класс:

```gdscript
# scripts/rooms_api.gd
class_name RoomsAPI
extends RefCounted

const BASE_URL := "https://play.domain.com/api"

static func create_room(host_name: String, callback: Callable) -> void:
    # создаёт HTTPRequest node, делает запрос, вызывает callback(result)
    pass

static func get_room(code: String, callback: Callable) -> void:
    pass
```

Аналогично `profile_api.gd` для Profile endpoints. Оба — `RefCounted` (не Node) для
простоты управления lifetime.

#### Существующий `_try_auto_join()` в lobby.gd

Текущий метод обрабатывает `?join=ADDR&name=NAME` с сырым WebSocket адресом. Новая
версия обрабатывает `?join=CODE` (6-char код) через API резолюцию:

```gdscript
func _process_url_params() -> void:
    var code := _get_url_param("join")
    if not code.is_empty():
        _pending_join_code = code.to_upper()
    var name_param := _get_url_param("name")
    if not name_param.is_empty():
        _suggested_name = name_param
    # ?profile=create
    if _get_url_param("profile") == "create":
        _force_first_time = true
```

---

### 12. Phasing

#### MVP (текущая итерация, реализует B + B2)

**Экраны:**
- [x] `[Splash]` — auth check + URL param parsing
- [x] `[First-time / Pick Nickname]` — ник, валидация, регистрация
- [x] `[Lobby Home]` — header с ником/K/D, список комнат с polling, кнопка "Создать"
- [x] `[Room Lobby]` — список игроков, кнопка "Поделиться ссылкой", Старт (host)
- [x] `[Profile Dashboard]` — минимальный (stats + logout)

**Функции:**
- [x] Список публичных комнат с auto-refresh каждые 4 секунды
- [x] Empty state с CTA "Создай первую комнату"
- [x] Создание комнаты — одна кнопка, дефолтные параметры, сразу в Room Lobby
- [x] Auto-join `?join=CODE` — полный flow (минует Lobby Home)
- [x] Auto-join `?join=CODE&name=NAME` — с предзаполненным ником
- [x] "Поделиться ссылкой" в Room Lobby (opt-in clipboard)
- [x] Toast notifications
- [x] localStorage недоступен → guest mode
- [x] Master-server down → degraded mode (список не грузится, exponential backoff)
- [x] Keyboard navigation (Tab/Enter/Escape)
- [x] Mobile portrait overlay

**НЕ в MVP:**
- Join by Code модалка (убрана — заменена списком и deep link)
- Детальная история матчей (Profile v2)
- Gamepad полная поддержка
- Анимированные переходы между экранами
- "Скопировать токен" для бекапа
- Фильтрация/сортировка списка комнат (v2)
- Spectator join в IN_MATCH (v2)

#### v2 (после MVP)

- Сортировка/фильтрация списка комнат (по статусу, по числу игроков)
- WebSocket-push обновление списка вместо polling
- Spectator join для IN_MATCH комнат
- История матчей в Profile Dashboard (последние 10)
- Nemesis / Prey / Favourite weapon
- Gamepad полная навигация
- Анимированные screen transitions (fade + slide)
- "Скопировать токен" в Profile Dashboard
- Play Again кнопка в Post-match (не возвращает в лобби, остаётся в комнате)
- Кастомное имя комнаты и выбор карты при создании

#### v3 (отложено)

- Friends list
- Party invites (invite конкретного никнейма, не код)
- Ranked queue (если появится matchmaking)
- Кастомизация карта в лобби
- Кастомное имя комнаты при создании

---

## Formulas

### Debounce Timer для Nick Validation

```
debounce_wait_ms = 400
trigger condition: input changed AND length >= 2 AND charset valid
API call: GET /api/profile/check?nick={value}
cancel previous timer on each keystroke
```

400ms — достаточно чтобы не спамить API при быстром вводе, достаточно быстро чтобы
feedback ощущался мгновенным.

### Invite Link Format

```
invite_link = base_url + "/?join=" + room_code
room_code = 6 символов из charset "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
example: https://play.domain.com/?join=XKCD42
```

`base_url` читается из конфига или `window.location.origin` через JavaScriptBridge.

### Toast Duration

```
display_duration_ms = 3000
fade_out_duration_ms = 300
total_visible_ms = 3300
```

### Auth Check Timeout

```
api_timeout_ms = 3000
fallback: использовать cached nickname из localStorage["smash_karts_nick"]
если cached nick есть: показать Lobby Home с деградированным режимом
если нет: показать First-time с предупреждением
```

---

## Edge Cases

(Consolidated from Section 9. Complete list for QA reference.)

| ID | Сценарий | Экран | Поведение |
|----|----------|-------|-----------|
| EC-01 | localStorage заблокирован | Splash | Guest mode, баннер на First-time, профиль не создаётся |
| EC-02 | Token есть, API 404 | Splash | Удалить token, перейти на First-time с "профиль не найден" |
| EC-03 | Token есть, API timeout | Splash | Использовать cached nick, открыть Lobby Home с "offline mode" баннером |
| EC-04 | API down при Create Room | Lobby Home | Toast "Сервис недоступен", кнопка разблокирована |
| EC-05 | Список комнат не загружается | Lobby Home | Текущий список остаётся на экране (не очищается), subtle индикатор "Нет связи". Exponential backoff: 4s → 8s → 16s → 30s. Toast только после 3 последовательных ошибок. |
| EC-06 | Список комнат пуст | Lobby Home | Empty state с CTA "Создай первую комнату". Polling продолжается. |
| EC-07 | Все комнаты FULL | Lobby Home | Показываются в списке с disabled кнопкой "—" и текстом "Полная". Кнопка "Создать комнату" доступна. |
| EC-08 | Игрок нажал на карточку, комната за это время заполнилась | Lobby Home | GET /api/rooms/{code} вернул FULL → toast "Комната заполнена. Попробуйте другую." → обновить список в фоне. |
| EC-09 | Игрок нажал на карточку, комната закрылась (хост ушёл) | Lobby Home | GET /api/rooms/{code} → 404 → toast "Комната больше не доступна." → обновить список. |
| EC-10 | Комната IN_MATCH при нажатии на карточку | Lobby Home | Кнопка disabled. Если статус пришёл уже после нажатия (race): toast "Матч уже начался. Подождите следующего раунда." |
| EC-11 | `?join=CODE` комната не найдена | Splash→Lobby Home | Toast поверх Lobby Home, _pending_join_code очищается |
| EC-12 | WS disconnect в Room Lobby | Room Lobby | Возврат на Lobby Home + toast "Потеряно соединение с комнатой." |
| EC-13 | Clipboard API недоступен | Room Lobby | Fallback popup с текстовым URL полем, auto-select. |
| EC-14 | Host уходит из Room Lobby | Room Lobby | Confirm dialog "Комната закроется для всех. Выйти?", при согласии → Lobby Home; остальные WS disconnect → toast |
| EC-15 | 1 игрок в комнате, нажал Старт | Room Lobby | Кнопка disabled, текст "Нужно 2 игрока" |
| EC-16 | Ник занят при регистрации | First-time | Suggestions как кнопки-чипы, основная кнопка disabled до выбора/ввода нового |
| EC-17 | Portrait orientation мобильный | Любой | Overlay "Поверни устройство", gameplay screens blocked, lobby screens — нет |
| EC-18 | Две вкладки одного игрока | Room Lobby | Разрешено, показываются как два отдельных игрока |
| EC-19 | `?profile=create` при наличии токена | Splash | First-time открывается, старый токен не удаляется до нового создания |

---

## Dependencies

### Upstream (Lobby UI depends on)

| System | Dependency | Type |
|--------|-----------|------|
| **Rooms System (B1)** | REST API (POST /api/rooms, GET /api/rooms/{code}), ws_url resolve, invite_link | Hard |
| **Profile System (B2)** | REST API (POST /api/profile/register, POST /api/profile/auth), token mechanism, nick validation | Hard |
| **Network Layer** | `NetworkManager.join_game(ws_url)`, `connection_failed` signal, `server_created` signal | Hard |
| **Match System** | COUNTDOWN trigger (host Start button → Match System), `match_started` → change scene | Hard |
| **PlayerData** | `PlayerData.my_name` — хранит ник текущей сессии | Soft |

### Downstream (depends on Lobby UI)

| System | What it needs |
|--------|--------------|
| **Game Scene** | Ник из `PlayerData.my_name` при спавне карта |
| **HUD** | `PlayerData.my_name` для killfeed и nametag |
| **Scoreboard UI** | Post-match возврат в Room Lobby (Play Again flow, v2) |

### Bidirectional

- **Rooms System ↔ Lobby UI**: Lobby создаёт комнаты через API, Rooms возвращает ws_url.
  Rooms System GDD упоминает "Lobby UI — задача C (UX designer)".
- **Profile System ↔ Lobby UI**: Profile определяет API endpoints и token lifecycle.
  Profile GDD раздел "Downstream: Lobby UI → Profile auth flow: токен → nickname → join".
- **Network Layer ↔ Lobby UI**: Lobby вызывает `join_game()`, Network сигналит об
  успехе/ошибке. Изменение: `join_game(ws_url)` теперь получает полный WSS URL от API
  вместо raw IP. `NetworkManager._read_port_arg()` остаётся для headless server.

---

## Tuning Knobs

| Knob | Default | Safe Range | Affects | Too Low | Too High |
|------|---------|------------|---------|---------|---------|
| `nick_debounce_ms` | 400 | 200-800 | Отзывчивость nick validation | Спам API, лишние requests | Чувствуется как лаг после ввода |
| `auth_check_timeout_ms` | 3000 | 1000-8000 | Время ожидания auth при splash | False-timeout на медленных соединениях | Долгий белый экран при старте |
| `toast_duration_ms` | 3000 | 1500-5000 | Время показа toast | Не успевают прочитать | Мешают взаимодействию |
| `create_room_timeout_ms` | 5000 | 3000-10000 | Timeout POST /api/rooms | Timeout при медленном spawn Godot | Долгий spinner, нет feedback |
| `room_list_poll_interval_ms` | 4000 | 2000-10000 | Частота обновления списка комнат | Излишний трафик, мерцание UI | Список заметно устаревает (игрок видит старые комнаты) |
| `room_list_backoff_cap_ms` | 30000 | 15000-60000 | Максимальный интервал при ошибках сети | — | Список долго не восстанавливается после сбоя |
| `room_join_timeout_ms` | 5000 | 3000-10000 | Timeout GET /api/rooms/{code} при нажатии на карточку | — | Долгое ожидание при мёртвом сервере |
| `room_start_min_players` | 2 | 1-10 | Минимум для активации кнопки Старт | 1 = можно стартовать в одиночку | Слишком много народу нужно |
| `clipboard_fallback_delay_ms` | 200 | 0-500 | Задержка перед показом fallback | Мигание если clipboard быстрый | Заметная задержка на мобильных |

---

## Acceptance Criteria

### Functional Tests (automated / manual)

**Splash / Auth:**
- [ ] Открыть страницу без токена → появляется First-time экран
- [ ] Открыть страницу с валидным токеном в localStorage → появляется Lobby Home с ником
- [ ] Открыть страницу с невалидным токеном → появляется First-time с "профиль не найден"
- [ ] localStorage недоступен → появляется First-time с guest-mode баннером

**First-time:**
- [ ] Ввести ник < 2 символа → кнопка disabled, сообщение "Минимум 2 символа"
- [ ] Ввести недопустимый символ (пробел, @) → сообщение об ошибке charset
- [ ] Ввести занятый ник → показываются 3 кнопки-чипа с альтернативами
- [ ] Кликнуть чип → ник подставляется в поле → проверяется → если свободен, кнопка активна
- [ ] Ввести зарезервированный ник ("admin") → "Это имя недоступно"
- [ ] Успешная регистрация → токен появляется в localStorage["smash_karts_token"]
- [ ] После регистрации → переход на Lobby Home с верным ником в header

**URL Params:**
- [ ] `?join=XKCD42` при наличии токена → авто-джоин без экрана First-time
- [ ] `?join=XKCD42` без токена → First-time с баннером "тебя пригласили", после регистрации → Room Lobby
- [ ] `?join=XKCD42&name=Vася` без токена → First-time с предзаполненным "Vася"
- [ ] `?join=INVALID` → джоин → API 404 → toast "Комната не найдена", Lobby Home

**Lobby Home — Room List:**
- [ ] Lobby Home загружается → список комнат получен от `GET /api/rooms`, отображается
- [ ] Список обновляется каждые 4 секунды без мигания / очистки на время запроса
- [ ] Комната WAITING → кнопка "Войти" активна, нажатие → Room Lobby
- [ ] Комната FULL → кнопка disabled, текст "Полная"
- [ ] Комната IN_MATCH → кнопка disabled, текст "В игре"
- [ ] Список пуст → empty state с кнопкой "Создай первую комнату"
- [ ] API недоступна 4с → список не очищается, subtle индикатор ошибки
- [ ] Нажал на комнату, за это время FULL → toast "Комната заполнена", список обновляется

**Create Room:**
- [ ] Нажать "Создать комнату" → spinner, затем сразу Room Lobby (без промежуточной модалки)
- [ ] Имя созданной комнаты в Room Lobby: "{ник хоста}'s room"
- [ ] Комната появляется в списке `GET /api/rooms` после создания
- [ ] При ошибке API → toast "Не удалось создать комнату", кнопка снова активна
- [ ] "Поделиться ссылкой" в Room Lobby → в clipboard попадает `https://домен/?join=CODE`

**Room Lobby:**
- [ ] Появляется список подключённых игроков (ник + ping)
- [ ] Кнопка Старт видна только у host (первый подключившийся)
- [ ] При 1 игроке: Старт disabled + "Нужно 2 игрока"
- [ ] При 2+ игроках: Старт enabled + "Готов к старту!"
- [ ] "Скопировать ссылку" копирует `?join=CODE` (не ws_url)
- [ ] Гость нажимает "Покинуть" → Lobby Home, Room Lobby закрывается
- [ ] Host нажимает "Покинуть" → confirm dialog
- [ ] Match start → overlay с countdown → смена сцены

**Accessibility:**
- [ ] Полный flow First-time → Lobby Home → Join by Code → Room Lobby выполним только клавиатурой
- [ ] Все интерактивные элементы имеют visible focus ring
- [ ] Escape закрывает все открытые модалки
- [ ] Toast читается при обычном браузерном zoom 150%

**Mobile:**
- [ ] Portrait → overlay видеть устройство, lobby работает
- [ ] Join by Code на mobile touch: поле активируется без проблем, клавиатура появляется
- [ ] Кнопки Lobby Home не обрезаются на экране 375px ширины

---

## Open Questions

1. **Play Again flow:** Когда матч заканчивается в Rooms MVP — возврат на Lobby Home или
   остаёмся в Room Lobby (POST_MATCH state)? Rooms GDD описывает "Play Again = WAITING без
   реконнекта". Это значит Room Lobby должен быть доступен и после матча. Нужно решить при
   реализации Match System + Rooms интеграции.

2. **Имя комнаты:** В MVP — автоматически генерируется как `"{host_name}'s room"`.
   Нужна ли форма для кастомного имени? Rooms GDD описывает поле `name` в Room объекте.
   Для MVP — авто. Для v2 (список стал основным flow) — кастомное имя становится важнее:
   игроки видят имя в списке и могут захотеть отличить "Дима для новичков" от "Дима хардкор".

3. **Выбор карты:** В Rooms GDD `POST /api/rooms` принимает `map`. В MVP одна карта (`map_1`).
   Нужен ли selector на экране Create Room? Отложить до появления второй карты.

4. **Ping display:** `known-issues.md` упоминает что ping display сломан. В Room Lobby
   ping показывается рядом с ником. Если система не работает — показывать "—" без ошибок.

5. **`smash_karts_nick` в localStorage:** Для cached degraded mode (EC-03) нужно сохранять
   ник отдельно от токена. Добавить `localStorage["smash_karts_nick"] = nickname_display`
   при каждом успешном auth. Удалять при logout.

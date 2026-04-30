extends Node

## Owns the local player's profile + auth_token. Talks to the master server.
## Replaces PlayerData as the source-of-truth for `my_nick`.

signal profile_loaded(data: Dictionary)
signal profile_load_failed(reason: String)
signal nick_available
signal nick_conflict(suggestions: Array)
signal register_failed(reason: String)
signal logged_out

const TOKEN_LS_KEY := "smash_karts_token"
const TOKEN_FILE_PATH := "user://profile.cfg"
const TOKEN_FILE_SECTION := "auth"
const TOKEN_FILE_KEY := "token"

var my_nick: String = ""
var my_token: String = ""
var profile: Dictionary = {}
var is_logged_in: bool = false

var _api_base: String = "http://127.0.0.1:8080/api"
var _js_fetch_cb: JavaScriptObject

# Pending fetch tasks (web): id -> Callable(on_done)
var _pending: Dictionary = {}
var _next_id: int = 1


func _ready() -> void:
	var override := OS.get_environment("MASTER_URL")
	if override != "":
		_api_base = "%s/api" % override.rstrip("/")
	# `?master=URL` URL-параметр для production override без env var
	var url_master := _read_url_param("master")
	if url_master != "":
		_api_base = "%s/api" % url_master.rstrip("/")
	print("[ProfileManager] api_base=", _api_base)
	if OS.has_feature("web"):
		_js_fetch_cb = JavaScriptBridge.create_callback(_on_js_fetch_response)


# ---------------------- Public API ----------------------

func auth_check_async() -> void:
	var token := _load_token()
	var is_desktop_debug: bool = OS.is_debug_build() and not OS.has_feature("web")
	print("[ProfileManager] auth_check_async: token_present=", token != "", " desktop_debug=", is_desktop_debug)
	if token == "":
		if is_desktop_debug:
			# Desktop debug: skip the FirstTime panel entirely. Auto-register/claim "Desktop".
			_desktop_auto_login()
			return
		profile_load_failed.emit("no_token")
		return
	_request("POST", "/profile/auth", {"auth_token": token},
		func(ok: bool, code: int, body: Variant):
			if ok and body is Dictionary and body.has("profile"):
				_apply_profile(body["nickname"], token, body["profile"])
				profile_loaded.emit(profile)
				return
			_clear_token_on_unauth(code)
			# Desktop debug: fall back to auto-register on stale/invalid token instead of FirstTime panel.
			if is_desktop_debug:
				_desktop_auto_login()
				return
			profile_load_failed.emit("auth_failed:%d" % code)
	)


# Desktop debug shortcut: always log in as "Desktop". Tries register first;
# on 409 (already exists) re-claims the nickname (re-issues a fresh token).
# This matches the intent that desktop builds shouldn't pester the dev with
# FirstTime panels every time the master DB is wiped or token expires.
func _desktop_auto_login() -> void:
	const DESKTOP_NICK := "Desktop"
	print("[ProfileManager] desktop auto-login as '", DESKTOP_NICK, "'")
	_request("POST", "/profile/register", {"nickname": DESKTOP_NICK},
		func(ok: bool, code: int, body: Variant):
			if ok and body is Dictionary and body.has("auth_token"):
				_apply_profile(body["nickname"], body["auth_token"], body["profile"])
				_save_token(body["auth_token"])
				profile_loaded.emit(profile)
				return
			if code == 409:
				# Profile exists from previous run — claim it for a fresh token.
				claim_async(DESKTOP_NICK)
				return
			profile_load_failed.emit("desktop_auto_login_failed:%d" % code)
	)


func register_async(nickname: String) -> void:
	_request("POST", "/profile/register", {"nickname": nickname},
		func(ok: bool, code: int, body: Variant):
			if ok and body is Dictionary and body.has("auth_token"):
				_apply_profile(body["nickname"], body["auth_token"], body["profile"])
				_save_token(body["auth_token"])
				profile_loaded.emit(profile)
				return
			if code == 409 and body is Dictionary:
				var details: Dictionary = body.get("details", {})
				var suggestions: Array = details.get("suggestions", [])
				nick_conflict.emit(suggestions)
				return
			var msg := "register_failed:%d" % code
			if body is Dictionary and body.has("message"):
				msg = body["message"]
			register_failed.emit(msg)
	)


func claim_async(nickname: String) -> void:
	_request("POST", "/profile/claim", {"nickname": nickname},
		func(ok: bool, code: int, body: Variant):
			if ok and body is Dictionary and body.has("auth_token"):
				_apply_profile(body["nickname"], body["auth_token"], body["profile"])
				_save_token(body["auth_token"])
				profile_loaded.emit(profile)
			else:
				register_failed.emit("claim_failed:%d" % code)
	)


func check_nick_async(nickname: String) -> void:
	var query := "?nick=%s" % nickname.uri_encode()
	_request("GET", "/profile/check%s" % query, null,
		func(ok: bool, code: int, body: Variant):
			if not ok or not (body is Dictionary):
				register_failed.emit("check_failed:%d" % code)
				return
			if body.get("available", false):
				nick_available.emit()
			else:
				nick_conflict.emit(body.get("suggestions", []))
	)


func logout() -> void:
	_clear_token()
	my_nick = ""
	my_token = ""
	profile = {}
	is_logged_in = false
	logged_out.emit()


# ---------------------- Internal ----------------------

func _apply_profile(nickname: String, token: String, profile_data: Dictionary) -> void:
	my_nick = nickname
	my_token = token
	profile = profile_data
	is_logged_in = true


func _clear_token_on_unauth(code: int) -> void:
	if code == 401 or code == 404:
		_clear_token()


func _request(method: String, path: String, body, on_done: Callable) -> void:
	var url: String = _api_base + path
	if OS.has_feature("web"):
		_request_web(method, url, body, path, on_done)
		return
	var http := HTTPRequest.new()
	add_child(http)
	http.timeout = 10.0
	http.request_completed.connect(
		func(_result: int, code: int, _headers: PackedStringArray, raw_body: PackedByteArray):
			var parsed: Variant = null
			if raw_body.size() > 0:
				parsed = JSON.parse_string(raw_body.get_string_from_utf8())
			var ok := code >= 200 and code < 300
			print("[ProfileManager] HTTP done code=", code, " ok=", ok, " path=", path)
			http.queue_free()
			on_done.call(ok, code, parsed)
	)
	var headers := PackedStringArray(["Content-Type: application/json", "Accept: application/json"])
	var http_method: int = HTTPClient.METHOD_GET
	match method:
		"POST": http_method = HTTPClient.METHOD_POST
		"PUT": http_method = HTTPClient.METHOD_PUT
		"DELETE": http_method = HTTPClient.METHOD_DELETE
		_: http_method = HTTPClient.METHOD_GET
	var payload := ""
	if body != null:
		payload = JSON.stringify(body)
	print("[ProfileManager] HTTP ", method, " ", url)
	var err := http.request(url, headers, http_method, payload)
	if err != OK:
		print("[ProfileManager] http.request err=", err)
		http.queue_free()
		on_done.call(false, 0, null)


func _request_web(method: String, url: String, body, path: String, on_done: Callable) -> void:
	var id := _next_id
	_next_id += 1
	_pending[id] = {"on_done": on_done, "path": path}
	var payload_js := "null"
	if body != null:
		payload_js = JSON.stringify(JSON.stringify(body)) # double-encode → js string literal
	var bridge := JavaScriptBridge.get_interface("window")
	if bridge == null:
		print("[ProfileManager] window bridge missing")
		_pending.erase(id)
		on_done.call(false, 0, null)
		return
	# Stash the callback under a unique key so the JS code can call it back.
	var cb_key := "_smk_cb_%d" % id
	bridge[cb_key] = _js_fetch_cb
	var js := """
		(function() {
			var url = %s;
			var method = %s;
			var bodyStr = %s;
			var id = %d;
			var cbKey = %s;
			var headers = {'Accept': 'application/json'};
			var init = {method: method, headers: headers, mode: 'cors', credentials: 'omit'};
			if (bodyStr !== null) {
				headers['Content-Type'] = 'application/json';
				init.body = bodyStr;
			}
			fetch(url, init).then(function(r) {
				return r.text().then(function(t) { return [r.status, t]; });
			}).then(function(pair) {
				var cb = window[cbKey];
				if (cb) { cb(id, pair[0], pair[1]); delete window[cbKey]; }
			}).catch(function(e) {
				var cb = window[cbKey];
				if (cb) { cb(id, 0, String(e)); delete window[cbKey]; }
			});
		})();
	""" % [
		JSON.stringify(url),
		JSON.stringify(method),
		payload_js,
		id,
		JSON.stringify(cb_key),
	]
	print("[ProfileManager] HTTP[web] ", method, " ", url)
	JavaScriptBridge.eval(js, true)


func _on_js_fetch_response(args: Array) -> void:
	if args.size() < 3:
		return
	var id := int(args[0])
	var status := int(args[1])
	var body_text := str(args[2])
	if not _pending.has(id):
		return
	var entry: Dictionary = _pending[id]
	_pending.erase(id)
	var parsed: Variant = null
	if body_text.length() > 0:
		parsed = JSON.parse_string(body_text)
	var ok := status >= 200 and status < 300
	print("[ProfileManager] HTTP[web] done code=", status, " ok=", ok, " path=", entry["path"])
	(entry["on_done"] as Callable).call(ok, status, parsed)


# ---------------------- Token storage ----------------------

func _save_token(token: String) -> void:
	if OS.has_feature("web"):
		var js := "window.localStorage.setItem('%s', '%s');" % [TOKEN_LS_KEY, token]
		JavaScriptBridge.eval(js)
		return
	var cf := ConfigFile.new()
	cf.load(TOKEN_FILE_PATH)
	cf.set_value(TOKEN_FILE_SECTION, TOKEN_FILE_KEY, token)
	cf.save(TOKEN_FILE_PATH)


func _load_token() -> String:
	if OS.has_feature("web"):
		var js := "window.localStorage.getItem('%s') || ''" % TOKEN_LS_KEY
		var raw: Variant = JavaScriptBridge.eval(js)
		if raw == null:
			return ""
		return str(raw)
	var cf := ConfigFile.new()
	if cf.load(TOKEN_FILE_PATH) != OK:
		return ""
	return cf.get_value(TOKEN_FILE_SECTION, TOKEN_FILE_KEY, "")


func _clear_token() -> void:
	if OS.has_feature("web"):
		JavaScriptBridge.eval("window.localStorage.removeItem('%s');" % TOKEN_LS_KEY)
		return
	var cf := ConfigFile.new()
	if cf.load(TOKEN_FILE_PATH) == OK:
		cf.erase_section_key(TOKEN_FILE_SECTION, TOKEN_FILE_KEY)
		cf.save(TOKEN_FILE_PATH)


func _read_url_param(key: String) -> String:
	if not OS.has_feature("web"):
		return ""
	var js := """
		(function() {
			var p = new URLSearchParams(window.location.search);
			return p.get('%s') || '';
		})()
	""" % key
	var raw: Variant = JavaScriptBridge.eval(js)
	if raw == null:
		return ""
	return str(raw)

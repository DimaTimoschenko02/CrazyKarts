extends Node

## Talks to the master server's /api/rooms endpoints. Autoload.
## Uses the same JS-fetch / HTTPRequest split as ProfileManager.

signal rooms_updated(rooms: Array)
signal room_created(room: Dictionary)
signal room_resolved(room: Dictionary)
signal request_failed(endpoint: String, code: int)

var _api_base: String = "http://127.0.0.1:8080/api"
var _js_fetch_cb: JavaScriptObject
var _pending: Dictionary = {}
var _next_id: int = 1


func _ready() -> void:
	var override := OS.get_environment("MASTER_URL")
	if override != "":
		_api_base = "%s/api" % override.rstrip("/")
	if OS.has_feature("web"):
		_js_fetch_cb = JavaScriptBridge.create_callback(_on_js_fetch_response)


func fetch_rooms_async() -> void:
	_request("GET", "/rooms", null,
		func(ok: bool, code: int, body: Variant):
			if not ok or not (body is Dictionary):
				request_failed.emit("fetch_rooms", code)
				return
			rooms_updated.emit(body.get("rooms", []))
	)


func create_room_async(opts: Dictionary) -> void:
	_request("POST", "/rooms", opts,
		func(ok: bool, code: int, body: Variant):
			if not ok or not (body is Dictionary):
				request_failed.emit("create_room", code)
				return
			room_created.emit(body)
	)


func resolve_room_async(code: String) -> void:
	_request("GET", "/rooms/%s" % code, null,
		func(ok: bool, http_code: int, body: Variant):
			if not ok or not (body is Dictionary):
				request_failed.emit("resolve_room:%s" % code, http_code)
				return
			room_resolved.emit(body)
	)


# ---------------------- HTTP plumbing (mirrors ProfileManager) ---------------

func _request(method: String, path: String, body, on_done: Callable) -> void:
	var url: String = _api_base + path
	if OS.has_feature("web"):
		_request_web(method, url, body, path, on_done)
		return
	var http := HTTPRequest.new()
	add_child(http)
	http.timeout = 10.0
	http.request_completed.connect(
		func(_result: int, code: int, _headers: PackedStringArray, raw: PackedByteArray):
			var parsed: Variant = null
			if raw.size() > 0:
				parsed = JSON.parse_string(raw.get_string_from_utf8())
			http.queue_free()
			on_done.call(code >= 200 and code < 300, code, parsed)
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
	var err := http.request(url, headers, http_method, payload)
	if err != OK:
		http.queue_free()
		on_done.call(false, 0, null)


func _request_web(method: String, url: String, body, path: String, on_done: Callable) -> void:
	var id := _next_id
	_next_id += 1
	_pending[id] = {"on_done": on_done, "path": path}
	var payload_js := "null"
	if body != null:
		payload_js = JSON.stringify(JSON.stringify(body))
	var bridge := JavaScriptBridge.get_interface("window")
	if bridge == null:
		_pending.erase(id)
		on_done.call(false, 0, null)
		return
	var cb_key := "_smk_rc_cb_%d" % id
	bridge[cb_key] = _js_fetch_cb
	var js := """
		(function() {
			var url = %s, method = %s, bodyStr = %s, id = %d, cbKey = %s;
			var headers = {'Accept': 'application/json'};
			var init = {method: method, headers: headers, mode: 'cors', credentials: 'omit'};
			if (bodyStr !== null) {
				headers['Content-Type'] = 'application/json';
				init.body = bodyStr;
			}
			fetch(url, init).then(function(r) {
				return r.text().then(function(t) { return [r.status, t]; });
			}).then(function(p) {
				var cb = window[cbKey];
				if (cb) { cb(id, p[0], p[1]); delete window[cbKey]; }
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
	JavaScriptBridge.eval(js, true)


func _on_js_fetch_response(args: Array) -> void:
	if args.size() < 3:
		return
	var id := int(args[0])
	var status := int(args[1])
	var text := str(args[2])
	if not _pending.has(id):
		return
	var entry: Dictionary = _pending[id]
	_pending.erase(id)
	var parsed: Variant = null
	if text.length() > 0:
		parsed = JSON.parse_string(text)
	(entry["on_done"] as Callable).call(status >= 200 and status < 300, status, parsed)

extends Node

## Server-only autoload that POSTs match-end stats to the master.
## Active only when RoomsReporter sees `--internal-token` in cmdline (i.e.,
## when master spawned this Godot process). Otherwise no-op.

signal submit_succeeded(payload: Dictionary)
signal submit_failed(reason: String)

var _api_base: String = "http://127.0.0.1:8080/api"


func _ready() -> void:
	var override := OS.get_environment("MASTER_URL")
	if override != "":
		_api_base = "%s/api" % override.rstrip("/")


func is_active() -> bool:
	if not RoomsReporter.is_room_server:
		return false
	if RoomsReporter.internal_token == "":
		return false
	return true


func submit_match_async(payload: Dictionary) -> void:
	if not is_active():
		return
	var http := HTTPRequest.new()
	add_child(http)
	http.timeout = 10.0
	http.request_completed.connect(
		func(_result: int, code: int, _headers: PackedStringArray, raw: PackedByteArray):
			http.queue_free()
			if code >= 200 and code < 300:
				submit_succeeded.emit(payload)
			else:
				var msg := "code:%d body:%s" % [code, raw.get_string_from_utf8()]
				submit_failed.emit(msg)
				push_warning("[MasterClient] match submit failed: %s" % msg)
	)
	var headers := PackedStringArray([
		"Content-Type: application/json",
		"Accept: application/json",
		"Authorization: Bearer %s" % RoomsReporter.internal_token,
	])
	var url: String = _api_base + "/internal/match/submit"
	var body := JSON.stringify(payload)
	var err := http.request(url, headers, HTTPClient.METHOD_POST, body)
	if err != OK:
		http.queue_free()
		submit_failed.emit("http_request_err:%d" % err)

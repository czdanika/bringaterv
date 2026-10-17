"""Bringaterv API – személyes rekordok (edzésenkénti legjobb idők, csúcsértékek)."""

from flask import Blueprint, jsonify

from auth import require_auth
from records import EFFORT_DISTANCES_M, PEAK_WINDOWS_S, records_for_index
from storage import _resolve_dirs
from utils import _load_index

bp = Blueprint("api_records", __name__)


@bp.route("/api/records", methods=["GET"])
@require_auth
def list_records():
    routes_dir, idx = _resolve_dirs()
    items, pending = records_for_index(routes_dir, _load_index(idx))
    return jsonify({
        "distances": EFFORT_DISTANCES_M,
        "windows":   PEAK_WINDOWS_S,
        "items":     items,
        "pending":   pending,     # még kiszámolandó edzések – a kliens újrakér
    })

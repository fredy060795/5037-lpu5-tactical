"""Tests for tak_integration.py with CoT as sent by ATAK/WinTAK."""

import hashlib
import io
import zipfile

import tak_integration as ti

ATAK_FREEHAND = """<event version="2.0" uid="a1b2-freehand" type="u-d-f" time="2026-10-23T10:00:00Z" start="2026-10-23T10:00:00Z" stale="2027-10-23T10:00:00Z" how="h-e">
<point lat="52.5200" lon="13.4050" hae="9999999.0" ce="9999999.0" le="9999999.0"/>
<detail><link point="52.5200,13.4050,0"/><link point="52.5210,13.4060,0"/><link point="52.5220,13.4040,0"/>
<strokeColor value="-65536"/><strokeWeight value="4.0"/><contact callsign="Phase Line Blau"/><remarks>PL Blau</remarks><archive/></detail></event>"""

ATAK_POLYGON = """<event version="2.0" uid="poly-1" type="u-d-f" time="2026-10-23T10:00:00Z" start="2026-10-23T10:00:00Z" stale="2027-10-23T10:00:00Z" how="h-e">
<point lat="52.5" lon="13.4" hae="0" ce="0" le="0"/>
<detail><link point="52.50,13.40"/><link point="52.51,13.40"/><link point="52.51,13.41"/><link point="52.50,13.40"/>
<strokeColor value="-16776961"/><fillColor value="1694498815"/><contact callsign="Sperrgebiet"/></detail></event>"""

ATAK_CIRCLE = """<event version="2.0" uid="circle-1" type="u-d-c-c" time="2026-10-23T10:00:00Z" start="2026-10-23T10:00:00Z" stale="2027-10-23T10:00:00Z" how="h-e">
<point lat="48.1" lon="11.5" hae="0" ce="0" le="0"/>
<detail><shape><ellipse major="250.0" minor="250.0" angle="360"/></shape><strokeColor value="-256"/><contact callsign="Radius 250"/></detail></event>"""

ATAK_ROUTE = """<event version="2.0" uid="route-1" type="b-m-r" time="2026-10-23T10:00:00Z" start="2026-10-23T10:00:00Z" stale="2027-10-23T10:00:00Z" how="h-e">
<point lat="52.0" lon="13.0" hae="0" ce="0" le="0"/>
<detail><link uid="wp1" callsign="SP" type="b-m-p-w" point="52.0,13.0" relation="c"/>
<link uid="wp2" callsign="CP1" type="b-m-p-c" point="52.01,13.02" relation="c"/>
<link uid="wp3" callsign="ZIEL" type="b-m-p-w" point="52.02,13.05" relation="c"/>
<link_attr method="Driving" direction="Infil" prefix="CP" type="Vehicle"/><contact callsign="Route Alpha"/></detail></event>"""

ATAK_911 = """<event version="2.0" uid="ANDROID-123-9-1-1" type="b-a-o-tbl" time="2026-10-23T10:00:00Z" start="2026-10-23T10:00:00Z" stale="2026-10-23T11:00:00Z" how="m-g">
<point lat="50.0" lon="8.0" hae="0" ce="10" le="10"/>
<detail><link uid="ANDROID-123" type="a-f-G-U-C" relation="p-p"/><contact callsign="VIPER-Alert"/><emergency type="911 Alert">VIPER</emergency></detail></event>"""

ATAK_CANCEL = """<event version="2.0" uid="ANDROID-123-9-1-1" type="b-a-o-can" time="2026-10-23T10:05:00Z" start="2026-10-23T10:05:00Z" stale="2026-10-23T10:06:00Z" how="m-g">
<point lat="50.0" lon="8.0" hae="0" ce="10" le="10"/>
<detail><link uid="ANDROID-123" type="a-f-G-U-C" relation="p-p"/><emergency cancel="true">VIPER</emergency></detail></event>"""

ATAK_MEDEVAC = """<event version="2.0" uid="medevac-1" type="b-r-f-h-c" time="2026-10-23T10:00:00Z" start="2026-10-23T10:00:00Z" stale="2026-10-24T10:00:00Z" how="h-g-i-g-o">
<point lat="49.0" lon="9.0" hae="0" ce="0" le="0"/>
<detail><contact callsign="MED.1"/><_medevac_ title="MED.1" freq="45.250" urgent="2" priority="1" routine="0" security="1" hlz_marking="3" litter="1" ambulatory="2" medline_remarks="Schussverletzung Bein"/></detail></event>"""

ATAK_VIDEO = """<event version="2.0" uid="video-drone-1" type="b-i-v" time="2026-10-23T10:00:00Z" start="2026-10-23T10:00:00Z" stale="2026-10-24T10:00:00Z" how="m-g">
<point lat="0" lon="0" hae="0" ce="0" le="0"/>
<detail><__video url="rtsp://10.0.0.5:8554/live"><ConnectionEntry networkTimeout="12000" uid="video-drone-1" path="/live" protocol="rtsp" bufferTime="-1" address="10.0.0.5" port="8554" roverPort="-1" rtspReliable="0" ignoreEmbeddedKLV="false" alias="Drohne 1"/></__video></detail></event>"""

ATAK_DELETE = """<event version="2.0" uid="del-x" type="t-x-d-d" time="2026-10-23T10:00:00Z" start="2026-10-23T10:00:00Z" stale="2026-10-23T10:01:00Z" how="h-g-i-g-o">
<point lat="0" lon="0" hae="0" ce="0" le="0"/><detail><link uid="a1b2-freehand" relation="none" type="none"/><__forcedelete/></detail></event>"""


def test_colors_roundtrip():
    assert ti.argb_to_hex("-65536") == ("#ff0000", 1.0)
    assert ti.hex_to_argb("#ff0000") == -65536
    assert ti.argb_to_hex(str(ti.hex_to_argb("#12ab34", 0.5)))[0] == "#12ab34"


def test_freehand_polyline():
    d = ti.cot_to_drawing(ti.parse_event(ATAK_FREEHAND))
    assert d["type"] == "polyline" and d["name"] == "Phase Line Blau"
    assert d["coordinates"] == [[52.52, 13.405], [52.521, 13.406], [52.522, 13.404]]
    assert d["color"] == "#ff0000" and d["weight"] == 4 and d["data"]["remarks"] == "PL Blau"


def test_closed_polygon_with_fill():
    d = ti.cot_to_drawing(ti.parse_event(ATAK_POLYGON))
    assert d["type"] == "polygon" and len(d["coordinates"]) == 3
    assert d["color"] == "#0000ff" and d["data"]["fill_color"] == "#ffffff"


def test_circle_and_route():
    c = ti.cot_to_drawing(ti.parse_event(ATAK_CIRCLE))
    assert c["type"] == "circle" and c["data"]["radius"] == 250.0 and c["coordinates"] == [[48.1, 11.5]]
    r = ti.cot_to_drawing(ti.parse_event(ATAK_ROUTE))
    assert r["type"] == "route" and [w["name"] for w in r["data"]["waypoints"]] == ["SP", "CP1", "ZIEL"]
    assert r["data"]["route"]["method"] == "Driving"


def test_lpu5_drawings_roundtrip_through_cot():
    for d in [
        {"id": "x1", "name": "Linie", "type": "polyline", "coordinates": [[1, 2], [3, 4]], "color": "#00ff00", "weight": 3},
        {"id": "x2", "name": "Fläche", "type": "polygon", "coordinates": [[1, 2], [3, 4], [5, 2]], "color": "#ff0000"},
        {"id": "x3", "name": "Kreis", "type": "circle", "coordinates": [[1, 2]], "data": {"radius": 500}},
        {"id": "x4", "name": "Weg", "type": "route", "coordinates": [[1, 2], [1.1, 2.1]],
         "data": {"waypoints": [{"name": "A"}, {"name": "B"}]}},
    ]:
        xml = ti.drawing_to_cot(d)
        root = ti.parse_event(xml)
        assert root.get("uid") == f"LPU5-D-{d['id']}"
        back = ti.cot_to_drawing(root)
        assert back["type"] == d["type"], (d["type"], back["type"])
        assert back["name"] == d["name"]
        assert len(back["coordinates"]) == len(d["coordinates"])
        if d["type"] == "circle":
            assert back["data"]["radius"] == 500


def test_alerts_and_cancel():
    a = ti.cot_to_alert(ti.parse_event(ATAK_911))
    assert a["kind"] == "911" and a["callsign"] == "VIPER" and a["sender_uid"] == "ANDROID-123"
    c = ti.cot_to_alert(ti.parse_event(ATAK_CANCEL))
    assert c["kind"] == "cancel"
    xml = ti.alert_to_cot({"kind": "in_contact", "callsign": "ALPHA", "lat": 1, "lng": 2})
    root = ti.parse_event(xml)
    assert root.get("type") == "b-a-o-opn" and root.find("detail/emergency").text == "ALPHA"


def test_casevac_both_ways():
    r = ti.cot_to_casevac(ti.parse_event(ATAK_MEDEVAC))
    assert r["fields"]["freq"] == "45.250" and r["fields"]["urgent"] == "2"
    xml = ti.casevac_to_cot({"callsign": "MED.2", "lat": 1, "lng": 2, "fields": {"urgent": "1", "medline_remarks": "x"}})
    back = ti.cot_to_casevac(ti.parse_event(xml))
    assert back["fields"]["urgent"] == "1" and back["fields"]["title"] == "MED.2"


def test_video_both_ways():
    v = ti.cot_to_video(ti.parse_event(ATAK_VIDEO))
    assert v == {"uid": "video-drone-1", "alias": "Drohne 1", "url": "rtsp://10.0.0.5:8554/live"}
    xml = ti.video_to_cot({"id": "vs-1", "name": "Tor Nord", "source": "rtsp://user:pw@10.0.0.9:554/s1"}, "x")
    root = ti.parse_event(xml)
    ce = root.find("detail/__video/ConnectionEntry")
    assert ce.get("address") == "10.0.0.9" and ce.get("port") == "554" and ce.get("alias") == "Tor Nord"
    assert ti.video_to_cot({"id": "r", "source": "relay:eud-x"}, "x") is None


def test_bridge_dispatch(tmp_path):
    seen = {"drawings": [], "deleted": [], "alerts": [], "videos": [], "sent": [], "bc": []}
    b = ti.TakBridge(str(tmp_path),
                     upsert_drawing=seen["drawings"].append, delete_drawing=seen["deleted"].append,
                     on_alert=seen["alerts"].append, add_video=seen["videos"].append,
                     send_cot=seen["sent"].append, broadcast=lambda c, e, d: seen["bc"].append((c, e)))
    for xml in (ATAK_FREEHAND, ATAK_ROUTE, ATAK_911, ATAK_VIDEO, ATAK_DELETE, ATAK_MEDEVAC):
        assert b.handle_inbound(xml) is True
    assert not b.handle_inbound('<event version="2.0" uid="u" type="a-f-G-U-C" time="x" start="x" stale="x" how="m-g"><point lat="1" lon="2" hae="0" ce="0" le="0"/></event>')
    assert [d["type"] for d in seen["drawings"]] == ["polyline", "route"]
    assert seen["deleted"] == ["a1b2-freehand"]
    assert len(b.active_alerts()) == 1 and seen["videos"][0]["alias"] == "Drohne 1"
    assert ("reports", "report") in seen["bc"]
    # echo of an LPU5 drawing is ignored
    assert b.handle_inbound(ti.drawing_to_cot({"id": "q", "type": "polyline", "coordinates": [[1, 1], [2, 2]]}))
    assert len(seen["drawings"]) == 2
    # LPU5-raised alert goes out as CoT and cancel clears it
    b.raise_alert("911", "ALPHA", 1, 2)
    assert ti.parse_event(seen["sent"][-1]).get("type") == "b-a-o-tbl"
    b.raise_alert("cancel", "ALPHA", 1, 2)
    assert all(a["callsign"] != "ALPHA" for a in b.active_alerts())


def test_data_packages(tmp_path):
    store = ti.DataPackageStore(str(tmp_path / "dp"))
    pkg = ti.mission_package("Test", {"overlay/a.kml": b"<kml/>", "x/x.cot": b'<event uid="1"/>'})
    e = store.add(pkg, "Test.zip", creator="ALPHA")
    assert e["hash"] == hashlib.sha256(pkg).hexdigest() and store.path(e["hash"])
    ex = ti.extract_package(pkg)
    assert len(ex["cot"]) == 1 and ex["overlays"][0]["name"] == "a.kml"
    assert ti.DataPackageStore(str(tmp_path / "dp")).get(e["hash"])["creator"] == "ALPHA"
    root = ti.parse_event(ti.fileshare_to_cot(e, "http://10.0.0.1:8080"))
    fs = ti.cot_to_fileshare(root)
    assert fs["sha256"] == e["hash"] and fs["url"].endswith(f"hash={e['hash']}")


def test_connection_package():
    z = zipfile.ZipFile(io.BytesIO(ti.connection_package("192.168.8.10", 8088, callsign="ALPHA-1")))
    names = z.namelist()
    assert "MANIFEST/manifest.xml" in names and "lpu5/lpu5.pref" in names
    pref = z.read("lpu5/lpu5.pref").decode()
    assert "192.168.8.10:8088:tcp" in pref and "ALPHA-1" in pref
    assert 'zipEntry="lpu5/lpu5.pref"' in z.read("MANIFEST/manifest.xml").decode()

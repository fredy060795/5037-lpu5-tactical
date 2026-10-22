// Round-trips the protobuf messages mesh.js builds, against the official
// Meshtastic schemas (no radio needed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, toBinary, fromBinary } from '@bufbuild/protobuf';
import { Mesh, Portnums, ATAK } from '@meshtastic/protobufs';

test('ATAK PLI packet round trip', () => {
  const tak = create(ATAK.TAKPacketSchema, {
    contact: create(ATAK.ContactSchema, { callsign: 'ALPHA-1', deviceCallsign: 'ALPHA-1' }),
    group: create(ATAK.GroupSchema, { team: ATAK.Team.Cyan, role: ATAK.MemberRole.TeamMember }),
    payloadVariant: { case: 'pli', value: create(ATAK.PLISchema, { latitudeI: 525200000, longitudeI: 134050000, altitude: 34, speed: 0, course: 90 }) },
  });
  const to = create(Mesh.ToRadioSchema, {
    payloadVariant: { case: 'packet', value: create(Mesh.MeshPacketSchema, {
      to: 0xffffffff, id: 42, payloadVariant: { case: 'decoded', value: create(Mesh.DataSchema, { portnum: Portnums.PortNum.ATAK_PLUGIN, payload: toBinary(ATAK.TAKPacketSchema, tak) }) },
    }) },
  });
  const back = fromBinary(Mesh.ToRadioSchema, toBinary(Mesh.ToRadioSchema, to));
  const data = back.payloadVariant.value.payloadVariant.value;
  assert.equal(data.portnum, 72);
  const t = fromBinary(ATAK.TAKPacketSchema, data.payload);
  assert.equal(t.contact.callsign, 'ALPHA-1');
  assert.equal(t.payloadVariant.case, 'pli');
  assert.equal(t.payloadVariant.value.latitudeI / 1e7, 52.52);
});

test('FromRadio text packet decodes', () => {
  const fr = create(Mesh.FromRadioSchema, {
    payloadVariant: { case: 'packet', value: create(Mesh.MeshPacketSchema, {
      from: 0x1234abcd, payloadVariant: { case: 'decoded', value: create(Mesh.DataSchema, { portnum: Portnums.PortNum.TEXT_MESSAGE_APP, payload: new TextEncoder().encode('Kontakt Nord') }) },
    }) },
  });
  const p = fromBinary(Mesh.FromRadioSchema, toBinary(Mesh.FromRadioSchema, fr)).payloadVariant.value;
  assert.equal(new TextDecoder().decode(p.payloadVariant.value.payload), 'Kontakt Nord');
});

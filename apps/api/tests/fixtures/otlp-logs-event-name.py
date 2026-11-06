"""Independent official-schema fixture; never use the receiver's JS encoder."""

import json

from opentelemetry.proto.collector.logs.v1.logs_service_pb2 import ExportLogsServiceRequest
from opentelemetry.proto.logs.v1.logs_pb2 import LogRecord

assert LogRecord.DESCRIPTOR.fields_by_name["event_name"].number == 12
request = ExportLogsServiceRequest()
request.resource_logs.add().scope_logs.add().log_records.add(event_name="evt")
wire = request.SerializeToString()
assert wire.hex() == "0a09120712056203657674"
assert ExportLogsServiceRequest.FromString(wire).resource_logs[0].scope_logs[0].log_records[0].event_name == "evt"
print(json.dumps({"hex": wire.hex()}))

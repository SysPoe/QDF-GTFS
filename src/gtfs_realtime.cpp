#include "GTFS.h"
#include "nanopb/pb_decode.h"
#include "gtfs-realtime.pb.h"
#include <string>
#include <vector>
#include <iostream>

namespace gtfs {

// --- Helper Functions for Nanopb Decoders ---

// Decodes a string from a protobuf field
bool decode_string(pb_istream_t *stream, const pb_field_t *field, void **arg) {
    std::string* str = (std::string*)*arg;

    // We need to read the data into a buffer first
    size_t len = stream->bytes_left;
    std::vector<char> buffer(len);

    if (!pb_read(stream, (pb_byte_t*)buffer.data(), len)) {
        return false;
    }

    // Append to existing string or set it? usually set.
    str->assign(buffer.data(), len);
    return true;
}

// Helper struct for TranslatedString decoding
struct TranslatedStringContext {
    std::string* target;
};

// --- Main Parsing Functions ---

// 1. Trip Updates

struct TripUpdateContext {
    GTFSData* data;
    RealtimeTripUpdate current_update;
};

// 2. Vehicle Positions

struct VehiclePositionContext {
    GTFSData* data;
    RealtimeVehiclePosition current_pos;
};

// 3. Alerts

struct AlertContext {
    GTFSData* data;
    RealtimeAlert current_alert;
};

// Callback for TranslatedString
bool decode_translated_string_content(pb_istream_t *stream, const pb_field_t *field, void **arg) {
    std::string* inner_str = (std::string*)*arg;
    GTFSv2_Realtime_TranslatedString_Translation t = GTFSv2_Realtime_TranslatedString_Translation_init_zero;

    std::string temp_text;
    t.text.funcs.decode = decode_string;
    t.text.arg = &temp_text;

    if (!pb_decode(stream, GTFSv2_Realtime_TranslatedString_Translation_fields, &t))
         return false;

    if (inner_str->empty()) {
        *inner_str = temp_text;
    }
    return true;
}

void setup_translated_string_decoding(GTFSv2_Realtime_TranslatedString& ts, std::string* target) {
    ts.translation.funcs.decode = decode_translated_string_content;
    ts.translation.arg = target;
}

// --- Main Entry Points ---

void parse_realtime_feed(GTFSData& data, const unsigned char* buf, size_t len, int type) {
    GTFSv2_Realtime_FeedMessage message = GTFSv2_Realtime_FeedMessage_init_zero;

    message.entity.funcs.decode = [](pb_istream_t *stream, const pb_field_t *field, void **arg) -> bool {
        GTFSData* data = (GTFSData*)*arg;

        GTFSv2_Realtime_FeedEntity entity = GTFSv2_Realtime_FeedEntity_init_zero;

        // Setup contexts
        TripUpdateContext tu_ctx;
        tu_ctx.data = data;

        VehiclePositionContext vp_ctx;
        vp_ctx.data = data;

        AlertContext al_ctx;
        al_ctx.data = data;

        // We are decoding FeedEntity.
        // Inside FeedEntity, we have OPTIONAL MESSAGEs: trip_update, vehicle, alert.
        // We need to pre-configure their callbacks because they are decoded recursively as part of FeedEntity.

        // --- Trip Update Setup ---
        entity.trip_update.trip.trip_id.funcs.decode = decode_string;
        entity.trip_update.trip.trip_id.arg = &tu_ctx.current_update.trip.trip_id;

        entity.trip_update.trip.route_id.funcs.decode = decode_string;
        entity.trip_update.trip.route_id.arg = &tu_ctx.current_update.trip.route_id;

        entity.trip_update.trip.start_time.funcs.decode = decode_string;
        entity.trip_update.trip.start_time.arg = &tu_ctx.current_update.trip.start_time;

        entity.trip_update.trip.start_date.funcs.decode = decode_string;
        entity.trip_update.trip.start_date.arg = &tu_ctx.current_update.trip.start_date;

        entity.trip_update.vehicle.id.funcs.decode = decode_string;
        entity.trip_update.vehicle.id.arg = &tu_ctx.current_update.vehicle.id;

        entity.trip_update.vehicle.label.funcs.decode = decode_string;
        entity.trip_update.vehicle.label.arg = &tu_ctx.current_update.vehicle.label;

        entity.trip_update.vehicle.license_plate.funcs.decode = decode_string;
        entity.trip_update.vehicle.license_plate.arg = &tu_ctx.current_update.vehicle.license_plate;

        entity.trip_update.stop_time_update.funcs.decode = [](pb_istream_t *stream, const pb_field_t *field, void **arg) -> bool {
            TripUpdateContext* inner_ctx = (TripUpdateContext*)*arg;
            RealtimeStopTimeUpdate stu;
            GTFSv2_Realtime_TripUpdate_StopTimeUpdate pb_stu = GTFSv2_Realtime_TripUpdate_StopTimeUpdate_init_zero;

            pb_stu.stop_id.funcs.decode = decode_string;
            pb_stu.stop_id.arg = &stu.stop_id;

            if (!pb_decode(stream, GTFSv2_Realtime_TripUpdate_StopTimeUpdate_fields, &pb_stu)) return false;

            stu.stop_sequence = pb_stu.stop_sequence;
            stu.schedule_relationship = pb_stu.schedule_relationship;
            if (pb_stu.has_arrival) {
                stu.arrival_delay = pb_stu.arrival.delay;
                stu.arrival_time = pb_stu.arrival.time;
            }
            if (pb_stu.has_departure) {
                stu.departure_delay = pb_stu.departure.delay;
                stu.departure_time = pb_stu.departure.time;
            }
            inner_ctx->current_update.stop_time_updates.push_back(stu);
            return true;
        };
        entity.trip_update.stop_time_update.arg = &tu_ctx;


        // --- Vehicle Position Setup ---
        entity.vehicle.trip.trip_id.funcs.decode = decode_string;
        entity.vehicle.trip.trip_id.arg = &vp_ctx.current_pos.trip.trip_id;

        entity.vehicle.trip.route_id.funcs.decode = decode_string;
        entity.vehicle.trip.route_id.arg = &vp_ctx.current_pos.trip.route_id;

        entity.vehicle.trip.start_time.funcs.decode = decode_string;
        entity.vehicle.trip.start_time.arg = &vp_ctx.current_pos.trip.start_time;

        entity.vehicle.trip.start_date.funcs.decode = decode_string;
        entity.vehicle.trip.start_date.arg = &vp_ctx.current_pos.trip.start_date;

        entity.vehicle.vehicle.id.funcs.decode = decode_string;
        entity.vehicle.vehicle.id.arg = &vp_ctx.current_pos.vehicle.id;

        entity.vehicle.vehicle.label.funcs.decode = decode_string;
        entity.vehicle.vehicle.label.arg = &vp_ctx.current_pos.vehicle.label;

        entity.vehicle.vehicle.license_plate.funcs.decode = decode_string;
        entity.vehicle.vehicle.license_plate.arg = &vp_ctx.current_pos.vehicle.license_plate;

        entity.vehicle.stop_id.funcs.decode = decode_string;
        entity.vehicle.stop_id.arg = &vp_ctx.current_pos.stop_id;


        // --- Alert Setup ---
        setup_translated_string_decoding(entity.alert.header_text, &al_ctx.current_alert.header_text);
        setup_translated_string_decoding(entity.alert.description_text, &al_ctx.current_alert.description_text);
        setup_translated_string_decoding(entity.alert.url, &al_ctx.current_alert.url);

        // Decode
        if (!pb_decode(stream, GTFSv2_Realtime_FeedEntity_fields, &entity))
            return false;

        // Post-decode logic to save data
        if (entity.has_trip_update) {
            tu_ctx.current_update.timestamp = entity.trip_update.timestamp;
            tu_ctx.current_update.delay = entity.trip_update.delay;
            tu_ctx.current_update.trip.direction_id = entity.trip_update.trip.direction_id;
            tu_ctx.current_update.trip.schedule_relationship = entity.trip_update.trip.schedule_relationship;
            tu_ctx.data->realtime_trip_updates.push_back(tu_ctx.current_update);
        }

        if (entity.has_vehicle) {
             vp_ctx.current_pos.current_stop_sequence = entity.vehicle.current_stop_sequence;
             vp_ctx.current_pos.current_status = entity.vehicle.current_status;
             vp_ctx.current_pos.timestamp = entity.vehicle.timestamp;
             vp_ctx.current_pos.congestion_level = entity.vehicle.congestion_level;
             vp_ctx.current_pos.occupancy_status = entity.vehicle.occupancy_status;
             vp_ctx.current_pos.trip.direction_id = entity.vehicle.trip.direction_id;
             vp_ctx.current_pos.trip.schedule_relationship = entity.vehicle.trip.schedule_relationship;
             if (entity.vehicle.has_position) {
                 vp_ctx.current_pos.position.latitude = entity.vehicle.position.latitude;
                 vp_ctx.current_pos.position.longitude = entity.vehicle.position.longitude;
                 vp_ctx.current_pos.position.bearing = entity.vehicle.position.bearing;
                 vp_ctx.current_pos.position.odometer = entity.vehicle.position.odometer;
                 vp_ctx.current_pos.position.speed = entity.vehicle.position.speed;
             }
             vp_ctx.data->realtime_vehicle_positions.push_back(vp_ctx.current_pos);
        }

        if (entity.has_alert) {
            al_ctx.current_alert.cause = entity.alert.cause;
            al_ctx.current_alert.effect = entity.alert.effect;
            al_ctx.current_alert.severity_level = entity.alert.severity_level;
            al_ctx.data->realtime_alerts.push_back(al_ctx.current_alert);
        }

        return true;
    };
    message.entity.arg = &data;

    pb_istream_t stream = pb_istream_from_buffer(buf, len);
    if (!pb_decode(&stream, GTFSv2_Realtime_FeedMessage_fields, &message)) {
        std::cerr << "Failed to parse protobuf: " << PB_GET_ERROR(&stream) << std::endl;
    }
}

} // namespace gtfs

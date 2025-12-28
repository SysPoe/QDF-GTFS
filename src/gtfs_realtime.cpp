#include "GTFS.h"
#include "nanopb/pb_decode.h"
#include "gtfs-realtime.pb.h"
#include <string>
#include <vector>
#include <iostream>

namespace gtfs {

bool decode_string(pb_istream_t *stream, const pb_field_t *field, void **arg) {
    std::string* str = (std::string*)*arg;

    size_t len = stream->bytes_left;
    std::vector<char> buffer(len);

    if (!pb_read(stream, (pb_byte_t*)buffer.data(), len)) {
        return false;
    }

    str->assign(buffer.data(), len);
    return true;
}

struct TranslatedStringContext {
    std::string* target;
};


struct TripUpdateContext {
    GTFSData* data;
    RealtimeTripUpdate current_update;
};


struct VehiclePositionContext {
    GTFSData* data;
    RealtimeVehiclePosition current_pos;
};


struct AlertContext {
    GTFSData* data;
    RealtimeAlert current_alert;
};

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


void parse_realtime_feed(GTFSData& data, const unsigned char* buf, size_t len, int type) {
    GTFSv2_Realtime_FeedMessage message = GTFSv2_Realtime_FeedMessage_init_zero;

    message.entity.funcs.decode = [](pb_istream_t *stream, const pb_field_t *field, void **arg) -> bool {
        GTFSData* data = (GTFSData*)*arg;

        GTFSv2_Realtime_FeedEntity entity = GTFSv2_Realtime_FeedEntity_init_zero;

        TripUpdateContext tu_ctx;
        tu_ctx.data = data;

        VehiclePositionContext vp_ctx;
        vp_ctx.data = data;

        AlertContext al_ctx;
        al_ctx.data = data;


        entity.id.funcs.decode = decode_string;
        std::string entity_id;
        entity.id.arg = &entity_id;

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
            stu.trip_id = inner_ctx->current_update.trip.trip_id;
            stu.start_date = inner_ctx->current_update.trip.start_date;
            stu.start_time = inner_ctx->current_update.trip.start_time;

            if (pb_stu.has_arrival) {
                if (pb_stu.arrival.has_delay) stu.arrival_delay = pb_stu.arrival.delay;
                else stu.arrival_delay = -2147483648;

                if (pb_stu.arrival.has_time) stu.arrival_time = pb_stu.arrival.time;
                else stu.arrival_time = -1;

                if (pb_stu.arrival.has_uncertainty) stu.arrival_uncertainty = pb_stu.arrival.uncertainty;
                else stu.arrival_uncertainty = -1;
            } else {
                stu.arrival_time = -1;
                stu.arrival_delay = -2147483648;
                stu.arrival_uncertainty = -1;
            }

            if (pb_stu.has_departure) {
                if (pb_stu.departure.has_delay) stu.departure_delay = pb_stu.departure.delay;
                else stu.departure_delay = -2147483648;

                if (pb_stu.departure.has_time) stu.departure_time = pb_stu.departure.time;
                else stu.departure_time = -1;

                if (pb_stu.departure.has_uncertainty) stu.departure_uncertainty = pb_stu.departure.uncertainty;
                else stu.departure_uncertainty = -1;
            } else {
                stu.departure_time = -1;
                stu.departure_delay = -2147483648;
                stu.departure_uncertainty = -1;
            }

            if (pb_stu.has_schedule_relationship) stu.schedule_relationship = pb_stu.schedule_relationship;
            else stu.schedule_relationship = 0;

            if (pb_stu.has_stop_sequence) stu.stop_sequence = pb_stu.stop_sequence;
            else stu.stop_sequence = -1;

            inner_ctx->current_update.stop_time_updates.push_back(stu);
            return true;
        };
        entity.trip_update.stop_time_update.arg = &tu_ctx;


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


        setup_translated_string_decoding(entity.alert.header_text, &al_ctx.current_alert.header_text);
        setup_translated_string_decoding(entity.alert.description_text, &al_ctx.current_alert.description_text);
        setup_translated_string_decoding(entity.alert.url, &al_ctx.current_alert.url);

        if (!pb_decode(stream, GTFSv2_Realtime_FeedEntity_fields, &entity))
            return false;

        if (entity.has_trip_update) {
            tu_ctx.current_update.update_id = entity_id;
            tu_ctx.current_update.is_deleted = entity.is_deleted;

            if (entity.trip_update.has_timestamp) tu_ctx.current_update.timestamp = entity.trip_update.timestamp;

            if (entity.trip_update.has_delay) tu_ctx.current_update.delay = entity.trip_update.delay;
            else tu_ctx.current_update.delay = -2147483648;

            if (entity.trip_update.trip.has_direction_id) tu_ctx.current_update.trip.direction_id = entity.trip_update.trip.direction_id;
            else tu_ctx.current_update.trip.direction_id = -1;

            if (entity.trip_update.trip.has_schedule_relationship) tu_ctx.current_update.trip.schedule_relationship = entity.trip_update.trip.schedule_relationship;
            else tu_ctx.current_update.trip.schedule_relationship = 0;

            for(auto& stu : tu_ctx.current_update.stop_time_updates) {
                if(stu.trip_id.empty()) {
                    stu.trip_id = tu_ctx.current_update.trip.trip_id;
                }
            }

            tu_ctx.data->realtime_trip_updates.push_back(tu_ctx.current_update);
        }

        if (entity.has_vehicle) {
             vp_ctx.current_pos.update_id = entity_id;
             vp_ctx.current_pos.is_deleted = entity.is_deleted;

             if (entity.vehicle.has_current_stop_sequence) vp_ctx.current_pos.current_stop_sequence = entity.vehicle.current_stop_sequence;
             else vp_ctx.current_pos.current_stop_sequence = -1;

             if (entity.vehicle.has_current_status) vp_ctx.current_pos.current_status = entity.vehicle.current_status;
             else vp_ctx.current_pos.current_status = -1;

             if (entity.vehicle.has_timestamp) vp_ctx.current_pos.timestamp = entity.vehicle.timestamp;

             if (entity.vehicle.has_congestion_level) vp_ctx.current_pos.congestion_level = entity.vehicle.congestion_level;
             else vp_ctx.current_pos.congestion_level = -1;

             if (entity.vehicle.has_occupancy_status) vp_ctx.current_pos.occupancy_status = entity.vehicle.occupancy_status;
             else vp_ctx.current_pos.occupancy_status = -1;

             if (entity.vehicle.has_occupancy_percentage) vp_ctx.current_pos.occupancy_percentage = entity.vehicle.occupancy_percentage;
             else vp_ctx.current_pos.occupancy_percentage = -1;

             if (entity.vehicle.trip.has_direction_id) vp_ctx.current_pos.trip.direction_id = entity.vehicle.trip.direction_id;
             else vp_ctx.current_pos.trip.direction_id = -1;

             if (entity.vehicle.trip.has_schedule_relationship) vp_ctx.current_pos.trip.schedule_relationship = entity.vehicle.trip.schedule_relationship;
             else vp_ctx.current_pos.trip.schedule_relationship = 0;

             if (entity.vehicle.has_position) {
                 vp_ctx.current_pos.position.latitude = entity.vehicle.position.latitude;
                 vp_ctx.current_pos.position.longitude = entity.vehicle.position.longitude;

                 if (entity.vehicle.position.has_bearing) vp_ctx.current_pos.position.bearing = entity.vehicle.position.bearing;
                 else vp_ctx.current_pos.position.bearing = -1.0f;

                 if (entity.vehicle.position.has_odometer) vp_ctx.current_pos.position.odometer = entity.vehicle.position.odometer;
                 else vp_ctx.current_pos.position.odometer = -1.0;

                 if (entity.vehicle.position.has_speed) vp_ctx.current_pos.position.speed = entity.vehicle.position.speed;
                 else vp_ctx.current_pos.position.speed = -1.0f;
             }
             vp_ctx.data->realtime_vehicle_positions.push_back(vp_ctx.current_pos);
        }

        if (entity.has_alert) {
            al_ctx.current_alert.update_id = entity_id;
            al_ctx.current_alert.is_deleted = entity.is_deleted;

            if (entity.alert.has_cause) al_ctx.current_alert.cause = entity.alert.cause;
            else al_ctx.current_alert.cause = -1;

            if (entity.alert.has_effect) al_ctx.current_alert.effect = entity.alert.effect;
            else al_ctx.current_alert.effect = -1;

            if (entity.alert.has_severity_level) al_ctx.current_alert.severity_level = entity.alert.severity_level;
            else al_ctx.current_alert.severity_level = -1;

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

}

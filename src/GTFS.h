#ifndef GTFS_H
#define GTFS_H

#include <string>
#include <vector>
#include <map>
#include <unordered_map>
#include <memory>
#include <iostream>
#include <algorithm>
#include <shared_mutex>
#include <mutex>

namespace gtfs {

// String Pool for memory optimization
class StringPool {
    std::unordered_map<std::string, uint32_t> str_to_id;
    std::vector<std::string> id_to_str;
    mutable std::shared_mutex mutex_;
public:
    void clear() {
        std::unique_lock<std::shared_mutex> lock(mutex_);
        str_to_id.clear();
        id_to_str.clear();
    }

    uint32_t intern(const std::string& s) {
        {
            std::shared_lock<std::shared_mutex> lock(mutex_);
            if (str_to_id.count(s)) return str_to_id.at(s);
        }
        std::unique_lock<std::shared_mutex> lock(mutex_);
        if (str_to_id.count(s)) return str_to_id.at(s);

        uint32_t id = static_cast<uint32_t>(id_to_str.size());
        str_to_id[s] = id;
        id_to_str.push_back(s);
        return id;
    }

    std::string get(uint32_t id) const {
        std::shared_lock<std::shared_mutex> lock(mutex_);
        if (id < id_to_str.size()) return id_to_str[id];
        return "";
    }
    
    // Check if string exists without creating it
    bool exists(const std::string& s) const {
        std::shared_lock<std::shared_mutex> lock(mutex_);
        return str_to_id.count(s);
    }
    
    uint32_t get_id(const std::string& s) const {
        std::shared_lock<std::shared_mutex> lock(mutex_);
        if (str_to_id.count(s)) return str_to_id.at(s);
        return 0xFFFFFFFF; // Sentinel for not found
    }
};

struct Agency {
    std::string agency_id;
    std::string agency_name;
    std::string agency_url;
    std::string agency_timezone;
    std::string agency_lang;
    std::string agency_phone;
    std::string agency_fare_url;
    std::string agency_email;
};

struct Calendar {
    std::string service_id;
    bool monday;
    bool tuesday;
    bool wednesday;
    bool thursday;
    bool friday;
    bool saturday;
    bool sunday;
    std::string start_date; // YYYYMMDD
    std::string end_date;   // YYYYMMDD
};

struct CalendarDate {
    std::string service_id;
    std::string date;       // YYYYMMDD
    int exception_type;
};

struct Route {
    std::string route_id;
    std::string agency_id;
    std::string route_short_name;
    std::string route_long_name;
    std::string route_desc;
    int route_type;
    std::string route_url;
    std::string route_color;
    std::string route_text_color;
    int continuous_pickup;
    int continuous_drop_off;
};

struct Stop {
    std::string stop_id;
    std::string stop_code;
    std::string stop_name;
    std::string stop_desc;
    double stop_lat;
    double stop_lon;
    std::string zone_id;
    std::string stop_url;
    int location_type;
    std::string parent_station;
    std::string stop_timezone;
    int wheelchair_boarding;
    std::string level_id;
    std::string platform_code;
};

struct StopTime {
    uint32_t trip_id;       // Interned ID
    int arrival_time;       // Seconds since midnight
    int departure_time;     // Seconds since midnight
    uint32_t stop_id;       // Interned ID
    int stop_sequence;
    uint32_t stop_headsign; // Interned ID
    int pickup_type;
    int drop_off_type;
    double shape_dist_traveled;
    int timepoint;
    int continuous_pickup;
    int continuous_drop_off;
};

struct Trip {
    std::string route_id;
    std::string service_id;
    std::string trip_id;
    std::string trip_headsign;
    std::string trip_short_name;
    int direction_id;
    std::string block_id;
    std::string shape_id;
    int wheelchair_accessible;
    int bikes_allowed;
};

struct Shape {
    std::string shape_id;
    double shape_pt_lat;
    double shape_pt_lon;
    int shape_pt_sequence;
    double shape_dist_traveled;
};

struct FeedInfo {
    std::string feed_publisher_name;
    std::string feed_publisher_url;
    std::string feed_lang;
    std::string default_lang;
    std::string feed_start_date;
    std::string feed_end_date;
    std::string feed_version;
    std::string feed_contact_email;
    std::string feed_contact_url;
};

// Realtime Structures
struct RealtimeTripDescriptor {
    std::string trip_id;
    std::string route_id;
    int direction_id = -1;
    std::string start_time;
    std::string start_date;
    int schedule_relationship = 0;
};

struct RealtimeVehicleDescriptor {
    std::string id;
    std::string label;
    std::string license_plate;
};

struct RealtimeStopTimeUpdate {
    int stop_sequence = -1;
    std::string stop_id;
    std::string trip_id;
    std::string start_date; // Reflect start_date from trip update
    std::string start_time; // Reflect start_time from trip update
    // 0 is a valid delay, need careful handling. Actually proto optional int32 defaults to 0 but has_ flag. We'll use INT_MIN or explicit logic? Let's use -999999 as sentinel for delay? No, delay can be negative. Let's use a struct or separate bool?
    // For simplicity with JS null, we can use a pointer or std::optional-like approach,
    // but sticking to simple sentinels for now.
    // INT32_MIN is -2147483648. Unlikely for delay?
    // Let's use a dedicated "undefined" value like -2147483648 for integers that can be negative.
    // For unsigned or positive-only, -1 is fine.
    int arrival_delay = -2147483648;
    int64_t arrival_time = -1;
    int arrival_uncertainty = -1;

    int departure_delay = -2147483648;
    int64_t departure_time = -1;
    int departure_uncertainty = -1;

    int schedule_relationship = 0;
};

struct RealtimeTripUpdate {
    std::string update_id;
    bool is_deleted = false;
    RealtimeTripDescriptor trip;
    RealtimeVehicleDescriptor vehicle;
    std::vector<RealtimeStopTimeUpdate> stop_time_updates;
    uint64_t timestamp = 0; // 0 is technically 1970, but usually means missing in GTFS-RT context?
    // Proto says: "If missing, the interval starts at minus infinity." for ranges.
    // For timestamp: "If missing...".
    // Let's use 0 as "missing" for uint64 timestamps since 1970 is unlikely valid for *realtime* data updates?
    // Actually, let's allow 0 and use another way? No, 0 is fine for timestamp sentinel if we treat it as null.
    // But Wait, 0 is valid. Let's use 0 for now as previously defined, but maybe we need a separate flag?
    // Let's use 0 as sentinel for timestamp.

    int delay = -2147483648;
};

struct RealtimePosition {
    float latitude = 0.0f;
    float longitude = 0.0f;
    float bearing = -1.0f;
    double odometer = -1.0;
    float speed = -1.0f;
};

struct RealtimeVehiclePosition {
    std::string update_id;
    bool is_deleted = false;
    RealtimeTripDescriptor trip;
    RealtimeVehicleDescriptor vehicle;
    RealtimePosition position;
    int current_stop_sequence = -1;
    std::string stop_id;
    int current_status = -1;
    uint64_t timestamp = 0;
    int congestion_level = -1;
    int occupancy_status = -1;
    int occupancy_percentage = -1;
};

struct RealtimeAlert {
    std::string update_id;
    bool is_deleted = false;
    std::vector<std::string> active_period_start;
    std::vector<std::string> active_period_end;
    // Simplified for now, complex to map all EntitySelectors
    int cause = -1;
    int effect = -1;
    std::string url;
    std::string header_text;
    std::string description_text;
    int severity_level = -1;
};

class GTFSData {
public:
    StringPool string_pool;

    // Realtime Data Containers
    std::vector<RealtimeTripUpdate> realtime_trip_updates;
    std::vector<RealtimeVehiclePosition> realtime_vehicle_positions;
    std::vector<RealtimeAlert> realtime_alerts;

    std::unordered_map<std::string, Agency> agencies;
    std::unordered_map<std::string, Calendar> calendars;
    std::unordered_map<std::string, std::unordered_map<std::string, int>> calendar_dates; 
    std::unordered_map<std::string, Route> routes;
    std::unordered_map<std::string, Stop> stops;
    
    std::vector<StopTime> stop_times; 
    
    // Secondary index: stop_id (string) -> indices. 
    // Optimization: Use interned ID as key? 
    // std::unordered_map<uint32_t, std::vector<size_t>>
    // But queries come in as strings. 
    // Let's use uint32_t for map key to save memory too!
    std::unordered_map<uint32_t, std::vector<size_t>> stop_times_by_stop_id;

    std::unordered_map<std::string, Trip> trips;
    std::vector<Shape> shapes;
    std::vector<FeedInfo> feed_info;

    void clear() {
        string_pool.clear();
        agencies.clear();
        calendars.clear();
        calendar_dates.clear();
        routes.clear();
        stops.clear();
        stop_times.clear();
        stop_times_by_stop_id.clear();
        trips.clear();
        shapes.clear();
        feed_info.clear();

        realtime_trip_updates.clear();
        realtime_vehicle_positions.clear();
        realtime_alerts.clear();
    }
};

} // namespace gtfs

#endif

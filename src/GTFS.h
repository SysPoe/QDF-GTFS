#ifndef GTFS_H
#define GTFS_H

#include <string>
#include <vector>
#include <map>
#include <unordered_map>
#include <memory>
#include <iostream>
#include <algorithm>

namespace gtfs {

// String Pool for memory optimization
class StringPool {
    std::unordered_map<std::string, uint32_t> str_to_id;
    std::vector<std::string> id_to_str;
public:
    void clear() {
        str_to_id.clear();
        id_to_str.clear();
    }

    uint32_t intern(const std::string& s) {
        if (str_to_id.count(s)) return str_to_id[s];
        uint32_t id = static_cast<uint32_t>(id_to_str.size());
        str_to_id[s] = id;
        id_to_str.push_back(s);
        return id;
    }

    std::string get(uint32_t id) const {
        if (id < id_to_str.size()) return id_to_str[id];
        return "";
    }
    
    // Check if string exists without creating it
    bool exists(const std::string& s) const {
        return str_to_id.count(s);
    }
    
    uint32_t get_id(const std::string& s) const {
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

class GTFSData {
public:
    StringPool string_pool;

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
    }
};

} // namespace gtfs

#endif

#include "GTFS.h"
#include "miniz.h"
#include <sstream>
#include <algorithm>
#include <string.h>
#include <cstdio>

namespace gtfs {

// Helper to convert "HH:MM:SS" to seconds
int parse_time_seconds(const std::string& time_str) {
    if (time_str.empty()) return -1;
    int h, m, s;
    if (std::sscanf(time_str.c_str(), "%d:%d:%d", &h, &m, &s) == 3) {
        return h * 3600 + m * 60 + s;
    }
    return -1; 
}

// Improved CSV parser
std::vector<std::string> parse_csv_line(const std::string& line) {
    std::vector<std::string> result;
    std::string cell;
    bool inside_quotes = false;
    for (size_t i = 0; i < line.length(); ++i) {
        char c = line[i];
        if (c == '"') {
            if (inside_quotes && i + 1 < line.length() && line[i+1] == '"') {
                cell += '"'; // unescape "" to "
                i++;
            } else {
                inside_quotes = !inside_quotes;
            }
        } else if (c == ',' && !inside_quotes) {
            result.push_back(cell);
            cell.clear();
        } else if (c == '\r') {
             continue;
        } else {
            cell += c;
        }
    }
    result.push_back(cell);
    return result;
}

int get_col_index(const std::vector<std::string>& headers, const std::string& name) {
    auto it = std::find(headers.begin(), headers.end(), name);
    if (it != headers.end()) {
        return std::distance(headers.begin(), it);
    }
    return -1;
}

std::string get_val(const std::vector<std::string>& row, int index, const std::string& default_val = "") {
    if (index >= 0 && index < (int)row.size()) {
        return row[index];
    }
    return default_val;
}

int get_int(const std::vector<std::string>& row, int index, int default_val = 0) {
    std::string val = get_val(row, index);
    if (val.empty()) return default_val;
    try {
        return std::stoi(val);
    } catch (...) {
        return default_val;
    }
}

double get_double(const std::vector<std::string>& row, int index, double default_val = 0.0) {
    std::string val = get_val(row, index);
    if (val.empty()) return default_val;
    try {
        return std::stod(val);
    } catch (...) {
        return default_val;
    }
}

bool get_bool(const std::vector<std::string>& row, int index, bool default_val = false) {
    std::string val = get_val(row, index);
    if (val.empty()) return default_val;
    return val == "1";
}


void parse_agency(GTFSData& data, const std::string& content) {
    std::stringstream ss(content);
    std::string line;
    std::getline(ss, line); // Header
    if (line.empty()) return;

    auto headers = parse_csv_line(line);
    int id_idx = get_col_index(headers, "agency_id");
    int name_idx = get_col_index(headers, "agency_name");
    int url_idx = get_col_index(headers, "agency_url");
    int tz_idx = get_col_index(headers, "agency_timezone");
    int lang_idx = get_col_index(headers, "agency_lang");
    int phone_idx = get_col_index(headers, "agency_phone");
    int fare_url_idx = get_col_index(headers, "agency_fare_url");
    int email_idx = get_col_index(headers, "agency_email");

    while (std::getline(ss, line)) {
        if (line.empty()) continue;
        auto row = parse_csv_line(line);
        Agency a;
        a.agency_id = get_val(row, id_idx);
        a.agency_name = get_val(row, name_idx);
        a.agency_url = get_val(row, url_idx);
        a.agency_timezone = get_val(row, tz_idx);
        a.agency_lang = get_val(row, lang_idx);
        a.agency_phone = get_val(row, phone_idx);
        a.agency_fare_url = get_val(row, fare_url_idx);
        a.agency_email = get_val(row, email_idx);
        data.agencies[a.agency_id] = a;
    }
}

void parse_routes(GTFSData& data, const std::string& content) {
    std::stringstream ss(content);
    std::string line;
    std::getline(ss, line);
    if (line.empty()) return;

    auto headers = parse_csv_line(line);
    int id_idx = get_col_index(headers, "route_id");
    int agency_id_idx = get_col_index(headers, "agency_id");
    int short_name_idx = get_col_index(headers, "route_short_name");
    int long_name_idx = get_col_index(headers, "route_long_name");
    int desc_idx = get_col_index(headers, "route_desc");
    int type_idx = get_col_index(headers, "route_type");
    int url_idx = get_col_index(headers, "route_url");
    int color_idx = get_col_index(headers, "route_color");
    int text_color_idx = get_col_index(headers, "route_text_color");

    while (std::getline(ss, line)) {
        if (line.empty()) continue;
        auto row = parse_csv_line(line);
        Route r;
        r.route_id = get_val(row, id_idx);
        r.agency_id = get_val(row, agency_id_idx);
        r.route_short_name = get_val(row, short_name_idx);
        r.route_long_name = get_val(row, long_name_idx);
        r.route_desc = get_val(row, desc_idx);
        r.route_type = get_int(row, type_idx);
        r.route_url = get_val(row, url_idx);
        r.route_color = get_val(row, color_idx);
        r.route_text_color = get_val(row, text_color_idx);
        data.routes[r.route_id] = r;
    }
}

void parse_trips(GTFSData& data, const std::string& content) {
    std::stringstream ss(content);
    std::string line;
    std::getline(ss, line);
    if (line.empty()) return;

    auto headers = parse_csv_line(line);
    int route_id_idx = get_col_index(headers, "route_id");
    int service_id_idx = get_col_index(headers, "service_id");
    int trip_id_idx = get_col_index(headers, "trip_id");
    int headsign_idx = get_col_index(headers, "trip_headsign");
    int short_name_idx = get_col_index(headers, "trip_short_name");
    int direction_id_idx = get_col_index(headers, "direction_id");
    int block_id_idx = get_col_index(headers, "block_id");
    int shape_id_idx = get_col_index(headers, "shape_id");
    int wheelchair_idx = get_col_index(headers, "wheelchair_accessible");
    int bikes_idx = get_col_index(headers, "bikes_allowed");

    while (std::getline(ss, line)) {
        if (line.empty()) continue;
        auto row = parse_csv_line(line);
        Trip t;
        t.route_id = get_val(row, route_id_idx);
        t.service_id = get_val(row, service_id_idx);
        t.trip_id = get_val(row, trip_id_idx);
        t.trip_headsign = get_val(row, headsign_idx);
        t.trip_short_name = get_val(row, short_name_idx);
        t.direction_id = get_int(row, direction_id_idx);
        t.block_id = get_val(row, block_id_idx);
        t.shape_id = get_val(row, shape_id_idx);
        t.wheelchair_accessible = get_int(row, wheelchair_idx);
        t.bikes_allowed = get_int(row, bikes_idx);
        data.trips[t.trip_id] = t;
    }
}

void parse_stops(GTFSData& data, const std::string& content) {
    std::stringstream ss(content);
    std::string line;
    std::getline(ss, line);
    if (line.empty()) return;

    auto headers = parse_csv_line(line);
    int id_idx = get_col_index(headers, "stop_id");
    int code_idx = get_col_index(headers, "stop_code");
    int name_idx = get_col_index(headers, "stop_name");
    int desc_idx = get_col_index(headers, "stop_desc");
    int lat_idx = get_col_index(headers, "stop_lat");
    int lon_idx = get_col_index(headers, "stop_lon");
    int zone_idx = get_col_index(headers, "zone_id");
    int url_idx = get_col_index(headers, "stop_url");
    int loc_type_idx = get_col_index(headers, "location_type");
    int parent_idx = get_col_index(headers, "parent_station");
    int tz_idx = get_col_index(headers, "stop_timezone");
    int wheelchair_idx = get_col_index(headers, "wheelchair_boarding");
    int level_idx = get_col_index(headers, "level_id");
    int platform_idx = get_col_index(headers, "platform_code");

    while (std::getline(ss, line)) {
        if (line.empty()) continue;
        auto row = parse_csv_line(line);
        Stop s;
        s.stop_id = get_val(row, id_idx);
        s.stop_code = get_val(row, code_idx);
        s.stop_name = get_val(row, name_idx);
        s.stop_desc = get_val(row, desc_idx);
        s.stop_lat = get_double(row, lat_idx);
        s.stop_lon = get_double(row, lon_idx);
        s.zone_id = get_val(row, zone_idx);
        s.stop_url = get_val(row, url_idx);
        s.location_type = get_int(row, loc_type_idx);
        s.parent_station = get_val(row, parent_idx);
        s.stop_timezone = get_val(row, tz_idx);
        s.wheelchair_boarding = get_int(row, wheelchair_idx);
        s.level_id = get_val(row, level_idx);
        s.platform_code = get_val(row, platform_idx);
        data.stops[s.stop_id] = s;
    }
}

void parse_stop_times(GTFSData& data, const std::string& content) {
    std::stringstream ss(content);
    std::string line;
    std::getline(ss, line);
    if (line.empty()) return;

    auto headers = parse_csv_line(line);
    int trip_id_idx = get_col_index(headers, "trip_id");
    int arrival_idx = get_col_index(headers, "arrival_time");
    int departure_idx = get_col_index(headers, "departure_time");
    int stop_id_idx = get_col_index(headers, "stop_id");
    int seq_idx = get_col_index(headers, "stop_sequence");
    int headsign_idx = get_col_index(headers, "stop_headsign");
    int pickup_idx = get_col_index(headers, "pickup_type");
    int drop_off_idx = get_col_index(headers, "drop_off_type");
    int dist_idx = get_col_index(headers, "shape_dist_traveled");
    int timepoint_idx = get_col_index(headers, "timepoint");

    while (std::getline(ss, line)) {
        if (line.empty()) continue;
        auto row = parse_csv_line(line);
        StopTime st;
        st.trip_id = data.string_pool.intern(get_val(row, trip_id_idx));
        st.arrival_time = parse_time_seconds(get_val(row, arrival_idx));
        st.departure_time = parse_time_seconds(get_val(row, departure_idx));
        st.stop_id = data.string_pool.intern(get_val(row, stop_id_idx));
        st.stop_sequence = get_int(row, seq_idx);
        st.stop_headsign = data.string_pool.intern(get_val(row, headsign_idx));
        st.pickup_type = get_int(row, pickup_idx);
        st.drop_off_type = get_int(row, drop_off_idx);
        st.shape_dist_traveled = get_double(row, dist_idx);
        st.timepoint = get_int(row, timepoint_idx);
        data.stop_times.push_back(st);
    }
}

void parse_calendar(GTFSData& data, const std::string& content) {
    std::stringstream ss(content);
    std::string line;
    std::getline(ss, line);
    if (line.empty()) return;

    auto headers = parse_csv_line(line);
    int service_id_idx = get_col_index(headers, "service_id");
    int mon_idx = get_col_index(headers, "monday");
    int tue_idx = get_col_index(headers, "tuesday");
    int wed_idx = get_col_index(headers, "wednesday");
    int thu_idx = get_col_index(headers, "thursday");
    int fri_idx = get_col_index(headers, "friday");
    int sat_idx = get_col_index(headers, "saturday");
    int sun_idx = get_col_index(headers, "sunday");
    int start_idx = get_col_index(headers, "start_date");
    int end_idx = get_col_index(headers, "end_date");

    while (std::getline(ss, line)) {
        if (line.empty()) continue;
        auto row = parse_csv_line(line);
        Calendar c;
        c.service_id = get_val(row, service_id_idx);
        c.monday = get_bool(row, mon_idx);
        c.tuesday = get_bool(row, tue_idx);
        c.wednesday = get_bool(row, wed_idx);
        c.thursday = get_bool(row, thu_idx);
        c.friday = get_bool(row, fri_idx);
        c.saturday = get_bool(row, sat_idx);
        c.sunday = get_bool(row, sun_idx);
        c.start_date = get_val(row, start_idx);
        c.end_date = get_val(row, end_idx);
        data.calendars[c.service_id] = c;
    }
}

void parse_calendar_dates(GTFSData& data, const std::string& content) {
    std::stringstream ss(content);
    std::string line;
    std::getline(ss, line);
    if (line.empty()) return;

    auto headers = parse_csv_line(line);
    int service_id_idx = get_col_index(headers, "service_id");
    int date_idx = get_col_index(headers, "date");
    int exc_idx = get_col_index(headers, "exception_type");

    while (std::getline(ss, line)) {
        if (line.empty()) continue;
        auto row = parse_csv_line(line);
        std::string service_id = get_val(row, service_id_idx);
        std::string date = get_val(row, date_idx);
        int exc = get_int(row, exc_idx);
        data.calendar_dates[service_id][date] = exc;
    }
}

void parse_shapes(GTFSData& data, const std::string& content) {
    std::stringstream ss(content);
    std::string line;
    std::getline(ss, line);
    if (line.empty()) return;

    auto headers = parse_csv_line(line);
    int id_idx = get_col_index(headers, "shape_id");
    int lat_idx = get_col_index(headers, "shape_pt_lat");
    int lon_idx = get_col_index(headers, "shape_pt_lon");
    int seq_idx = get_col_index(headers, "shape_pt_sequence");
    int dist_idx = get_col_index(headers, "shape_dist_traveled");

    while (std::getline(ss, line)) {
        if (line.empty()) continue;
        auto row = parse_csv_line(line);
        Shape s;
        s.shape_id = get_val(row, id_idx);
        s.shape_pt_lat = get_double(row, lat_idx);
        s.shape_pt_lon = get_double(row, lon_idx);
        s.shape_pt_sequence = get_int(row, seq_idx);
        s.shape_dist_traveled = get_double(row, dist_idx);
        data.shapes.push_back(s);
    }
}

void parse_feed_info(GTFSData& data, const std::string& content) {
    std::stringstream ss(content);
    std::string line;
    std::getline(ss, line);
    if (line.empty()) return;

    auto headers = parse_csv_line(line);
    int pub_name_idx = get_col_index(headers, "feed_publisher_name");
    int pub_url_idx = get_col_index(headers, "feed_publisher_url");
    int lang_idx = get_col_index(headers, "feed_lang");
    int def_lang_idx = get_col_index(headers, "default_lang");
    int start_idx = get_col_index(headers, "feed_start_date");
    int end_idx = get_col_index(headers, "feed_end_date");
    int ver_idx = get_col_index(headers, "feed_version");
    int email_idx = get_col_index(headers, "feed_contact_email");
    int contact_url_idx = get_col_index(headers, "feed_contact_url");

    while (std::getline(ss, line)) {
        if (line.empty()) continue;
        auto row = parse_csv_line(line);
        FeedInfo f;
        f.feed_publisher_name = get_val(row, pub_name_idx);
        f.feed_publisher_url = get_val(row, pub_url_idx);
        f.feed_lang = get_val(row, lang_idx);
        f.default_lang = get_val(row, def_lang_idx);
        f.feed_start_date = get_val(row, start_idx);
        f.feed_end_date = get_val(row, end_idx);
        f.feed_version = get_val(row, ver_idx);
        f.feed_contact_email = get_val(row, email_idx);
        f.feed_contact_url = get_val(row, contact_url_idx);
        data.feed_info.push_back(f);
    }
}

void load_from_zip(GTFSData& data, const unsigned char* zip_data, size_t zip_size) {
    data.clear(); // Clear existing data

    mz_zip_archive zip_archive;
    memset(&zip_archive, 0, sizeof(zip_archive));

    if (!mz_zip_reader_init_mem(&zip_archive, zip_data, zip_size, 0)) {
        // Handle error: Failed to init zip reader
        std::cerr << "Failed to init zip reader" << std::endl;
        return;
    }

    int file_count = mz_zip_reader_get_num_files(&zip_archive);
    for (int i = 0; i < file_count; i++) {
        mz_zip_archive_file_stat file_stat;
        if (!mz_zip_reader_file_stat(&zip_archive, i, &file_stat)) continue;

        std::string filename = file_stat.m_filename;
        size_t uncomp_size = file_stat.m_uncomp_size;
        void* p = mz_zip_reader_extract_file_to_heap(&zip_archive, filename.c_str(), &uncomp_size, 0);
        if (!p) continue;

        std::string content((char*)p, uncomp_size);
        mz_free(p);

        if (filename == "agency.txt") parse_agency(data, content);
        else if (filename == "routes.txt") parse_routes(data, content);
        else if (filename == "trips.txt") parse_trips(data, content);
        else if (filename == "stops.txt") parse_stops(data, content);
        else if (filename == "stop_times.txt") parse_stop_times(data, content);
        else if (filename == "calendar.txt") parse_calendar(data, content);
        else if (filename == "calendar_dates.txt") parse_calendar_dates(data, content);
        else if (filename == "shapes.txt") parse_shapes(data, content);
        else if (filename == "feed_info.txt") parse_feed_info(data, content);
    }

    mz_zip_reader_end(&zip_archive);

    // Sort stop_times by trip_id and sequence for fast lookup
    std::sort(data.stop_times.begin(), data.stop_times.end(), 
        [](const StopTime& a, const StopTime& b) {
            if (a.trip_id != b.trip_id) {
                return a.trip_id < b.trip_id;
            }
            return a.stop_sequence < b.stop_sequence;
        }
    );

    // Populate secondary index using interned IDs
    for (size_t i = 0; i < data.stop_times.size(); ++i) {
        data.stop_times_by_stop_id[data.stop_times[i].stop_id].push_back(i);
    }
}

} // namespace gtfs
